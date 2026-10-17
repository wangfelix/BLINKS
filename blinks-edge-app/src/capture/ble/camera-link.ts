import { fromByteArray, toByteArray } from "base64-js";
import {
  BleManager,
  type Device,
  type Subscription,
} from "react-native-ble-plx";

import {
  BLE_CONTROL_CHARACTERISTIC_UUID,
  BLE_DEVICE_INFO_CHARACTERISTIC_UUID,
  BLE_DEVICE_NAME,
  BLE_FRAME_CHARACTERISTIC_UUID,
  BLE_SERVICE_UUID,
  CONTROL_OPCODE_PAUSE,
  CONTROL_OPCODE_RESUME,
} from "@/capture/ble/ble-constants";
import {
  cameraCaptureConfigStore,
  cameraIntervalWarning,
  encodeSetIntervalCommand,
  parseCameraDeviceInfo,
  type CameraDeviceInfo,
} from "@/capture/ble/camera-device-info";
import { AssembledFrame, FrameAssembler } from "@/capture/ble/frame-assembler";
import {
  appConfigStore,
  desiredCaptureIntervalMs,
} from "@/study/model/app-config-store";

export type CameraLinkStatus =
  | "idle"
  | "bluetoothOff"
  | "scanning"
  | "connecting"
  | "connected";

const SCAN_RESTART_MS = 30_000;
const SCAN_RETRY_INITIAL_MS = 2_000;
const SCAN_RETRY_MAX_MS = 30_000;
const RECONNECT_RETRY_MS = 3_000;
// The capture-interval handshake must never delay frame monitoring for long.
const CAPTURE_INTERVAL_TIMEOUT_MS = 5_000;

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms} ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

interface CameraLinkEvents {
  // deviceId is the camera's BLE MAC with colons stripped (the server's
  // device identity, same convention as the old WiFi pipeline).
  onFrame: (frame: AssembledFrame, deviceId: string) => void;
  onStatusChange: (status: CameraLinkStatus) => void;
  onDeviceIdentified: (deviceId: string) => void;
}

// BLE central for the BLINKS camera: scans by name (the 128-bit service UUID
// does not fit the advertising packet next to the name), connects, subscribes
// to frame notifications, and exposes the pause/resume control write. Owns
// reconnection: after the first connection it reconnects directly to the same
// BLE address, so a camera power cycle does not depend on Android continuing an
// unfiltered scan while the phone screen is off.
export class CameraLink {
  private readonly manager = new BleManager();
  private readonly assembler = new FrameAssembler();
  private device: Device | null = null;
  private knownDeviceId: string | null = null;
  private running = false;
  private bluetoothPoweredOn = false;
  private connecting = false;
  private scanning = false;
  private desiredPaused = false;
  private bluetoothStateSubscription: Subscription | null = null;
  private appConfigUnsubscribe: (() => void) | null = null;
  // Firmware with characteristic 0004 accepts the 0x03 set-interval command.
  private supportsInterval = false;
  // "<formFactor>:<intervalMs>" last written on the current connection.
  private appliedIntervalKey: string | null = null;
  private scanRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private scanRetryMs = SCAN_RETRY_INITIAL_MS;

  constructor(private readonly events: CameraLinkEvents) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    cameraCaptureConfigStore.set({
      deviceInfo: null,
      supportsInterval: null,
      warning: null,
    });
    // A form-factor change in Study Settings (or a refreshed config) rewrites
    // the interval on the live connection right away.
    this.appConfigUnsubscribe = appConfigStore.subscribe(() =>
      this.handleAppConfigChange(),
    );
    this.bluetoothStateSubscription = this.manager.onStateChange((state) => {
      if (!this.running) return;
      if (state === "PoweredOn") {
        this.bluetoothPoweredOn = true;
        this.ensureConnection();
      } else {
        this.bluetoothPoweredOn = false;
        this.stopScan();
        this.clearReconnectTimer();
        this.events.onStatusChange("bluetoothOff");
      }
    }, true);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.bluetoothPoweredOn = false;
    this.bluetoothStateSubscription?.remove();
    this.bluetoothStateSubscription = null;
    this.appConfigUnsubscribe?.();
    this.appConfigUnsubscribe = null;
    this.stopScan();
    this.clearReconnectTimer();
    const deviceId = this.device?.id ?? this.knownDeviceId;
    if (deviceId) {
      await this.manager.cancelDeviceConnection(deviceId).catch(() => {});
    }
    this.device = null;
    this.assembler.reset();
    this.events.onStatusChange("idle");
    this.manager.destroy();
  }

  // Remembered and re-asserted on every (re)connect: the firmware resets its
  // paused flag on disconnect and treats the phone as the authority.
  async setPaused(paused: boolean): Promise<void> {
    this.desiredPaused = paused;
    await this.writePausedState().catch(() => {
      // Not connected right now; the state is re-asserted on reconnect.
    });
  }

  private ensureConnection(): void {
    if (
      !this.running ||
      !this.bluetoothPoweredOn ||
      this.device ||
      this.connecting
    ) {
      return;
    }
    if (this.knownDeviceId) {
      void this.reconnectToKnownDevice();
    } else {
      this.startScan();
    }
  }

  private startScan(): void {
    if (
      !this.running ||
      !this.bluetoothPoweredOn ||
      this.device ||
      this.connecting ||
      this.scanning
    ) {
      return;
    }
    this.scanning = true;
    this.events.onStatusChange("scanning");
    // No UUID filter: match by advertised name (see ble-constants).
    void this.manager
      .startDeviceScan(null, null, (error, device) => {
        if (!this.running) return;
        if (error) {
          this.handleScanFailure(error);
          return;
        }
        const name = device?.name ?? device?.localName;
        if (device && name === BLE_DEVICE_NAME && !this.connecting) {
          this.scanning = false;
          this.clearScanRestartTimer();
          void this.manager.stopDeviceScan().catch(() => {});
          void this.connectToScannedDevice(device);
        }
      })
      .catch((error: unknown) => this.handleScanFailure(error));

    this.scanRestartTimer = setTimeout(() => {
      this.scanRestartTimer = null;
      if (!this.scanning) return;
      this.scanning = false;
      void this.manager.stopDeviceScan().catch(() => {});
      this.startScan();
    }, SCAN_RESTART_MS);
  }

  private stopScan(): void {
    this.scanning = false;
    this.clearScanRestartTimer();
    void this.manager.stopDeviceScan().catch(() => {});
  }

  private handleScanFailure(error: unknown): void {
    if (!this.running || !this.scanning) return;
    console.warn("BLE camera scan failed; retrying:", error);
    this.stopScan();
    const retryMs = this.scanRetryMs;
    this.scanRetryMs = Math.min(this.scanRetryMs * 2, SCAN_RETRY_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.startScan();
    }, retryMs);
  }

  private async connectToScannedDevice(device: Device): Promise<void> {
    this.connecting = true;
    this.stopScan();
    this.events.onStatusChange("connecting");
    try {
      const connected = await device.connect();
      await this.finishConnection(connected);
    } catch (error) {
      console.warn("BLE camera connection failed; scanning again:", error);
      this.device = null;
    } finally {
      this.connecting = false;
      if (this.running && !this.device) this.scheduleReconnect();
    }
  }

  private async reconnectToKnownDevice(): Promise<void> {
    if (!this.knownDeviceId || this.connecting) return;
    this.connecting = true;
    this.events.onStatusChange("connecting");
    try {
      // Android's autoConnect waits for this known peripheral to become
      // available and does not require an unfiltered BLE scan to stay active.
      const connected = await this.manager.connectToDevice(this.knownDeviceId, {
        autoConnect: true,
      });
      await this.finishConnection(connected);
    } catch (error) {
      console.warn("BLE camera reconnect failed; retrying:", error);
      this.device = null;
    } finally {
      this.connecting = false;
      if (this.running && !this.device) this.scheduleReconnect();
    }
  }

  private async finishConnection(connected: Device): Promise<void> {
    if (!this.running) {
      await connected.cancelConnection().catch(() => {});
      return;
    }
    try {
      await connected.requestMTU(517).catch(() => {});
      await connected.discoverAllServicesAndCharacteristics();
      if (!this.running) {
        await connected.cancelConnection().catch(() => {});
        return;
      }

      this.device = connected;
      this.knownDeviceId = connected.id;
      this.supportsInterval = false;
      this.appliedIntervalKey = null;
      this.scanRetryMs = SCAN_RETRY_INITIAL_MS;
      this.clearReconnectTimer();

      const deviceId = connected.id.replace(/:/g, "");
      this.events.onDeviceIdentified(deviceId);

      connected.onDisconnected(() => {
        this.assembler.reset();
        this.device = null;
        // The firmware falls back to its default interval on disconnect.
        this.supportsInterval = false;
        this.appliedIntervalKey = null;
        if (this.running) this.scheduleReconnect();
      });

      // Connect order per docs/ble-capture-config.md: device info + 0x03,
      // pause re-assert, then frame notifications. Never aborts recording.
      await withTimeout(
        this.applyCaptureInterval(connected),
        CAPTURE_INTERVAL_TIMEOUT_MS,
      ).catch((error) =>
        console.warn("BLE capture interval handshake skipped:", error),
      );

      // The firmware starts capturing the moment a central connects, so a
      // paused session must re-assert pause before frames pile up.
      if (this.desiredPaused) await this.writePausedState().catch(() => {});

      connected.monitorCharacteristicForService(
        BLE_SERVICE_UUID,
        BLE_FRAME_CHARACTERISTIC_UUID,
        (error, characteristic) => {
          if (error || !characteristic?.value) return;
          const frame = this.assembler.push(characteristic.value);
          if (frame) this.events.onFrame(frame, deviceId);
        },
      );

      this.events.onStatusChange("connected");
    } catch (error) {
      this.device = null;
      await connected.cancelConnection().catch(() => {});
      throw error;
    }
  }

  private scheduleReconnect(): void {
    if (
      !this.running ||
      !this.bluetoothPoweredOn ||
      this.device ||
      this.connecting ||
      this.reconnectTimer
    ) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnection();
    }, RECONNECT_RETRY_MS);
  }

  private clearScanRestartTimer(): void {
    if (!this.scanRestartTimer) return;
    clearTimeout(this.scanRestartTimer);
    this.scanRestartTimer = null;
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private async applyCaptureInterval(device: Device): Promise<void> {
    try {
      const characteristics =
        await device.characteristicsForService(BLE_SERVICE_UUID);
      const hasDeviceInfo = characteristics.some(
        (characteristic) =>
          characteristic.uuid.toLowerCase() ===
          BLE_DEVICE_INFO_CHARACTERISTIC_UUID,
      );
      const before = hasDeviceInfo ? await this.readDeviceInfo(device) : null;
      if (!before) {
        console.info(
          "BLE camera firmware has no capture-interval support; using its default.",
        );
        cameraCaptureConfigStore.set({
          deviceInfo: null,
          supportsInterval: false,
          warning: null,
        });
        return;
      }
      this.supportsInterval = true;
      console.info("BLE camera device info:", JSON.stringify(before));
      cameraCaptureConfigStore.set({
        deviceInfo: before,
        supportsInterval: true,
        warning: null,
      });
      await this.writeCaptureInterval(device);
    } catch (error) {
      console.warn(
        "BLE capture interval could not be applied; camera keeps its interval:",
        error,
      );
    }
  }

  private async writeCaptureInterval(device: Device): Promise<void> {
    const appState = appConfigStore.getState();
    const intervalMs = desiredCaptureIntervalMs(appState);
    const formFactor = appState.cameraFormFactor;
    if (intervalMs === null || formFactor === null) {
      // Never loaded the config (or no form factor yet): no 0x03, the camera
      // records with its firmware default.
      console.info("No cached capture interval; camera keeps its default.");
      return;
    }
    this.appliedIntervalKey = `${formFactor}:${intervalMs}`;
    try {
      await device.writeCharacteristicWithResponseForService(
        BLE_SERVICE_UUID,
        BLE_CONTROL_CHARACTERISTIC_UUID,
        fromByteArray(encodeSetIntervalCommand(intervalMs)),
      );
    } catch (error) {
      this.appliedIntervalKey = null;
      throw error;
    }
    const after = await this.readDeviceInfo(device);
    if (!after) return;
    const formFactors = appState.config?.devices.formFactors ?? [];
    const warning = cameraIntervalWarning(
      after,
      intervalMs,
      formFactor,
      (key) =>
        formFactors.find((candidate) => candidate.key === key)?.displayLabel ??
        key,
    );
    if (warning) {
      console.warn("BLE capture interval:", warning, JSON.stringify(after));
    } else {
      console.info("BLE capture interval applied:", JSON.stringify(after));
    }
    cameraCaptureConfigStore.set({
      deviceInfo: after,
      supportsInterval: true,
      warning,
    });
  }

  private handleAppConfigChange(): void {
    const device = this.device;
    if (!device || !this.supportsInterval) return;
    const appState = appConfigStore.getState();
    const intervalMs = desiredCaptureIntervalMs(appState);
    if (intervalMs === null || appState.cameraFormFactor === null) return;
    if (
      this.appliedIntervalKey === `${appState.cameraFormFactor}:${intervalMs}`
    ) {
      return;
    }
    void this.writeCaptureInterval(device).catch((error) =>
      console.warn("BLE capture interval could not be rewritten:", error),
    );
  }

  private async readDeviceInfo(
    device: Device,
  ): Promise<CameraDeviceInfo | null> {
    const characteristic = await device.readCharacteristicForService(
      BLE_SERVICE_UUID,
      BLE_DEVICE_INFO_CHARACTERISTIC_UUID,
    );
    if (!characteristic.value) return null;
    return parseCameraDeviceInfo(toByteArray(characteristic.value));
  }

  private async writePausedState(): Promise<void> {
    if (!this.device) throw new Error("camera not connected");
    const opcode = this.desiredPaused
      ? CONTROL_OPCODE_PAUSE
      : CONTROL_OPCODE_RESUME;
    await this.device.writeCharacteristicWithResponseForService(
      BLE_SERVICE_UUID,
      BLE_CONTROL_CHARACTERISTIC_UUID,
      fromByteArray(Uint8Array.of(opcode)),
    );
  }
}
