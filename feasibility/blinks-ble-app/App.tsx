import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  Image,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Platform,
  PermissionsAndroid,
} from "react-native";
import { BleManager, Device } from "react-native-ble-plx";
import { Buffer } from "buffer";
import { fromByteArray } from "base64-js";
import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";
import notifee, { AndroidImportance } from "@notifee/react-native";

// ===========================================================================
// BLINKS feasibility spike — phone side.
//
// Connects to the ESP32 "BLINKS-CAM" BLE peripheral, reassembles each JPEG, and
// saves it locally with a receipt timestamp. A notifee foreground service keeps
// the process (and therefore the BLE link) alive while the app is backgrounded.
// The ONLY question this answers: do frames keep arriving overnight with the
// screen off? Read "Analyze saved frames" after the run to see count vs gaps.
//
// No VPN, no server. Frames are saved to <documentDirectory>/frames/.
// ===========================================================================

// Must match the firmware.
const SERVICE_UUID = "9a8b7c6d-0001-4a5b-8c9d-0e1f2a3b4c5d";
const FRAME_CHAR_UUID = "9a8b7c6d-0002-4a5b-8c9d-0e1f2a3b4c5d";
const DEVICE_NAME = "BLINKS-CAM";

// Match firmware CAPTURE_INTERVAL_MS (used only for the expected-count estimate).
// MUST match the firmware CAPTURE_INTERVAL_MS (5000 for bring-up, 30000 for the
// overnight run), or the delivery % below is meaningless.
const EXPECTED_INTERVAL_MS = 5000;
// If a frame is not completed within this long, assume a dropped chunk and
// resync to the next header.
const FRAME_TIMEOUT_MS = 10000;

// Diagnostic flag: with this false, Start does permissions + BLE only (no
// foreground service), i.e. foreground-only — to isolate whether the crash on
// Start is the foreground service. Flip back to true once the FGS is fixed.
const USE_FOREGROUND_SERVICE = true;

const FRAMES_DIR = FileSystem.documentDirectory + "frames/";

const manager = new BleManager();

export default function App() {
  const [status, setStatus] = useState("idle");
  const [frames, setFrames] = useState(0);
  const [lastFrameAt, setLastFrameAt] = useState<string>("—");
  const [totalBytes, setTotalBytes] = useState(0);
  const [running, setRunning] = useState(false);
  const [analysis, setAnalysis] = useState<string>("");
  const [lastFrameUri, setLastFrameUri] = useState<string | null>(null);

  // Frame-reassembly state (refs so they survive re-renders / background).
  const collecting = useRef(false);
  const expectedLen = useRef(0);
  const buf = useRef<Buffer[]>([]);
  const got = useRef(0);
  const frameCount = useRef(0);
  const frameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deviceRef = useRef<Device | null>(null);
  const seenDevices = useRef<Set<string>>(new Set());
  const rawNotifs = useRef(0);

  useEffect(() => {
    FileSystem.makeDirectoryAsync(FRAMES_DIR, { intermediates: true }).catch(
      () => {},
    );
    return () => {
      manager.stopDeviceScan();
      deviceRef.current?.cancelConnection().catch(() => {});
    };
  }, []);

  async function requestPermissions(): Promise<boolean> {
    if (Platform.OS !== "android") return true;
    const sdk = Platform.Version as number;
    const perms: string[] = [];
    if (sdk >= 31) {
      perms.push(
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      );
    } else {
      perms.push(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
    }
    if (sdk >= 33) {
      perms.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    }
    const res = await PermissionsAndroid.requestMultiple(perms as any);
    return Object.values(res).every((v) => v === "granted");
  }

  async function startForegroundService() {
    const channelId = await notifee.createChannel({
      id: "blinks",
      name: "BLINKS capture",
      importance: AndroidImportance.LOW,
    });
    await notifee.displayNotification({
      id: "blinks-fgs",
      title: "BLINKS is recording",
      body: "Receiving frames over Bluetooth",
      android: {
        channelId,
        asForegroundService: true,
        ongoing: true,
        // Android 14+ requires a service type; connectedDevice fits BLE.
        foregroundServiceTypes: [16 /* Android FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE */],
        smallIcon: "ic_launcher",
      },
    });
  }

  function resetFrameState() {
    collecting.current = false;
    expectedLen.current = 0;
    buf.current = [];
    got.current = 0;
    if (frameTimer.current) clearTimeout(frameTimer.current);
    frameTimer.current = null;
  }

  async function saveFrame(data: Buffer) {
    const ts = Date.now();
    frameCount.current += 1;
    const idx = frameCount.current; // ref, not stale `frames` state
    const name = `frame-${String(idx).padStart(6, "0")}-${ts}.jpg`;
    try {
      await FileSystem.writeAsStringAsync(
        FRAMES_DIR + name,
        fromByteArray(data), // base64-js: reliable encoder (buffer's was rejected)
        { encoding: FileSystem.EncodingType.Base64 },
      );
    } catch (e) {
      log(`save error: ${String(e)}`);
    }
    setFrames(idx);
    setTotalBytes((b) => b + data.length);
    setLastFrameAt(new Date(ts).toLocaleTimeString());
    setLastFrameUri(FRAMES_DIR + name);
  }

  function onValue(base64Value: string | null | undefined) {
    if (!base64Value) return;
    const chunk = Buffer.from(base64Value, "base64");
    if (chunk.length < 1) return;
    const tag = chunk[0];

    if (frameTimer.current) clearTimeout(frameTimer.current);
    frameTimer.current = setTimeout(() => resetFrameState(), FRAME_TIMEOUT_MS);

    if (tag === 0x01) {
      // header: [0x01][len BE 4 bytes]
      if (chunk.length < 5) return;
      const len = chunk.readUInt32BE(1);
      if (len <= 0 || len > 200000) {
        log(`bad length ${len}, ignoring`);
        resetFrameState();
        return;
      }
      expectedLen.current = len;
      buf.current = [];
      got.current = 0;
      collecting.current = true;
    } else if (tag === 0x02) {
      // data: [0x02][payload...]
      if (!collecting.current) return; // stray data before a header — ignore
      const payload = chunk.subarray(1);
      buf.current.push(payload);
      got.current += payload.length;
      if (got.current >= expectedLen.current) {
        const full = Buffer.concat(buf.current).subarray(0, expectedLen.current);
        saveFrame(full);
        resetFrameState();
      }
    }
  }

  async function connectTo(device: Device) {
    try {
      setStatus("connecting");
      manager.stopDeviceScan();
      const d = await device.connect();
      deviceRef.current = d;
      await d.requestMTU(517).catch(() => {});
      await d.discoverAllServicesAndCharacteristics();
      d.onDisconnected(() => {
        setStatus("disconnected — rescanning");
        resetFrameState();
        if (running) startScan();
      });
      rawNotifs.current = 0;
      d.monitorCharacteristicForService(
        SERVICE_UUID,
        FRAME_CHAR_UUID,
        (error, characteristic) => {
          if (error) {
            log(`monitor error: ${error.message}`);
            return;
          }
          rawNotifs.current += 1;
          if (rawNotifs.current <= 3 || rawNotifs.current % 25 === 0) {
            log(`notif #${rawNotifs.current} b64len=${characteristic?.value?.length ?? 0}`);
          }
          try {
            onValue(characteristic?.value);
          } catch (e) {
            log(`onValue err: ${String(e)}`);
          }
        },
      );
      setStatus("connected");
      log("connected, subscribed to frames");
    } catch (e) {
      log(`connect error: ${String(e)}`);
      setStatus("error — rescanning");
      if (running) startScan();
    }
  }

  function startScan() {
    setStatus("scanning");
    seenDevices.current.clear();
    // Scan with NO UUID filter and match by name: a 128-bit service UUID + the
    // name overflow the 31-byte advertising packet, so the UUID may not be in
    // the advertisement. Log each named device so we can see what's advertised.
    manager.startDeviceScan(null, null, (error, device) => {
      if (error) {
        log(`scan error: ${error.message}`);
        return;
      }
      if (device?.id && !seenDevices.current.has(device.id)) {
        seenDevices.current.add(device.id);
        const nm = device.name ?? device.localName;
        if (nm) log(`found: ${nm}`);
      }
      if (device && (device.name === DEVICE_NAME || device.localName === DEVICE_NAME)) {
        connectTo(device);
      }
    });
  }

  async function onStart() {
    const ok = await requestPermissions();
    if (!ok) {
      setStatus("permissions denied");
      return;
    }
    if (USE_FOREGROUND_SERVICE) {
      try {
        await startForegroundService();
      } catch (e) {
        log(`foreground service failed: ${String(e)}`);
      }
    }
    setRunning(true);
    const sub = manager.onStateChange((state) => {
      if (state === "PoweredOn") {
        sub.remove();
        startScan();
      }
    }, true);
  }

  async function onStop() {
    setRunning(false);
    manager.stopDeviceScan();
    await deviceRef.current?.cancelConnection().catch(() => {});
    await notifee.stopForegroundService();
    setStatus("stopped");
  }

  async function analyze() {
    try {
      const files = (await FileSystem.readDirectoryAsync(FRAMES_DIR)).filter(
        (f) => f.endsWith(".jpg"),
      );
      const ts = files
        .map((f) => {
          const m = f.match(/-(\d+)\.jpg$/);
          return m ? parseInt(m[1], 10) : 0;
        })
        .filter((t) => t > 0)
        .sort((a, b) => a - b);
      if (ts.length < 2) {
        setAnalysis(`saved frames: ${ts.length} (need 2+ to analyze gaps)`);
        return;
      }
      const durationMs = ts[ts.length - 1] - ts[0];
      const expected = Math.floor(durationMs / EXPECTED_INTERVAL_MS) + 1;
      let maxGap = 0;
      for (let i = 1; i < ts.length; i++) maxGap = Math.max(maxGap, ts[i] - ts[i - 1]);
      const mins = (durationMs / 60000).toFixed(1);
      setAnalysis(
        `saved: ${ts.length} frames over ${mins} min\n` +
          `expected ~${expected} at ${EXPECTED_INTERVAL_MS / 1000}s spacing\n` +
          `delivery: ${((100 * ts.length) / expected).toFixed(0)}%\n` +
          `largest gap: ${(maxGap / 1000).toFixed(0)}s\n` +
          `first: ${new Date(ts[0]).toLocaleString()}\n` +
          `last:  ${new Date(ts[ts.length - 1]).toLocaleString()}`,
      );
    } catch (e) {
      setAnalysis(`analyze error: ${String(e)}`);
    }
  }

  async function clearFrames() {
    await FileSystem.deleteAsync(FRAMES_DIR, { idempotent: true });
    await FileSystem.makeDirectoryAsync(FRAMES_DIR, { intermediates: true });
    frameCount.current = 0;
    setFrames(0);
    setTotalBytes(0);
    setLastFrameAt("—");
    setAnalysis("");
    setLastFrameUri(null);
    log("cleared saved frames");
  }

  async function shareFrames() {
    try {
      const files = (await FileSystem.readDirectoryAsync(FRAMES_DIR))
        .filter((f) => f.endsWith(".jpg"))
        .sort();
      const csv =
        "index;epoch_ms;filename\n" +
        files
          .map((f, i) => {
            const m = f.match(/-(\d+)\.jpg$/);
            return `${i + 1};${m ? m[1] : ""};${f}`;
          })
          .join("\n");
      const csvPath = FileSystem.documentDirectory + "frames-log.csv";
      await FileSystem.writeAsStringAsync(csvPath, csv);
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(csvPath);
    } catch (e) {
      log(`share error: ${String(e)}`);
    }
  }

  const [logLines, setLogLines] = useState<string[]>([]);
  function log(line: string) {
    const stamped = `${new Date().toLocaleTimeString()}  ${line}`;
    setLogLines((l) => [stamped, ...l].slice(0, 50));
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>BLINKS BLE spike</Text>
      <Text style={styles.status}>status: {status}</Text>
      <Text style={styles.metric}>frames received: {frames}</Text>
      <Text style={styles.metric}>last frame: {lastFrameAt}</Text>
      <Text style={styles.metric}>
        total: {(totalBytes / 1024).toFixed(1)} KB
      </Text>

      <View style={styles.row}>
        <TouchableOpacity
          style={[styles.btn, running && styles.btnDisabled]}
          onPress={onStart}
          disabled={running}
        >
          <Text style={styles.btnText}>Start</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.btn, !running && styles.btnDisabled]}
          onPress={onStop}
          disabled={!running}
        >
          <Text style={styles.btnText}>Stop</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.row}>
        <TouchableOpacity style={styles.btn} onPress={analyze}>
          <Text style={styles.btnText}>Analyze saved frames</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.btn} onPress={shareFrames}>
          <Text style={styles.btnText}>Share log</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.row}>
        <TouchableOpacity style={styles.btn} onPress={clearFrames}>
          <Text style={styles.btnText}>Clear saved frames</Text>
        </TouchableOpacity>
      </View>

      {lastFrameUri ? (
        <Image
          source={{ uri: lastFrameUri }}
          style={styles.preview}
          resizeMode="contain"
        />
      ) : null}

      {analysis ? <Text style={styles.analysis}>{analysis}</Text> : null}

      <Text style={styles.logHeader}>log</Text>
      <ScrollView style={styles.log}>
        {logLines.map((l, i) => (
          <Text key={i} style={styles.logLine}>
            {l}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, paddingTop: 60, backgroundColor: "#111" },
  title: { color: "#fff", fontSize: 22, fontWeight: "700", marginBottom: 12 },
  status: { color: "#7ad", fontSize: 16, marginBottom: 8 },
  metric: { color: "#ddd", fontSize: 16, marginBottom: 4 },
  row: { flexDirection: "row", gap: 10, marginTop: 14 },
  btn: {
    flex: 1,
    backgroundColor: "#2a6",
    padding: 14,
    borderRadius: 8,
    alignItems: "center",
  },
  btnDisabled: { backgroundColor: "#444" },
  btnText: { color: "#fff", fontWeight: "600" },
  preview: {
    width: "100%",
    height: 150,
    marginTop: 14,
    borderRadius: 8,
    backgroundColor: "#000",
  },
  analysis: {
    color: "#fe9",
    fontSize: 14,
    marginTop: 16,
    fontFamily: Platform.OS === "ios" ? "Courier" : "monospace",
  },
  logHeader: { color: "#888", marginTop: 18, marginBottom: 4 },
  log: { flex: 1, backgroundColor: "#000", borderRadius: 8, padding: 8 },
  logLine: { color: "#6c6", fontSize: 11, fontFamily: "monospace" },
});
