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
  "idle" | "bluetoothOff" | "scanning" | "connecting" | "connected";

const SCAN_RESTART_MS = 30_000;
const SCAN_RETRY_INITIAL_MS = 2_000;
const SCAN_RETRY_MAX_MS = 30_000;
const RECONNECT_RETRY_MS = 3_000;
// The capture-interval handshake must never delay frame monitoring for long.
const CAPTURE_INTERVAL_TIMEOUT_MS = 5_000;

class HandshakeAbortedError extends Error {
  constructor(reason: string) {
    super(`capture-interval handshake aborted: ${reason}`);
    this.name = "HandshakeAbortedError";
  }
}

// AbortController whose signal also fires when the parent aborts (the
// connection's controller), or after timeoutMs. AbortSignal.any/timeout are
// not available on Hermes, hence by hand.
const childController = (
  parent: AbortSignal,
  timeoutMs: number,
): { controller: AbortController; dispose: () => void } => {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parent.reason);
  if (parent.aborted) {
    controller.abort(parent.reason);
  } else {
    parent.addEventListener("abort", onParentAbort);
  }
  const timer = setTimeout(
    () => controller.abort(`timed out after ${timeoutMs} ms`),
    timeoutMs,
  );
  return {
    controller,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", onParentAbort);
    },
  };
};

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) {
    throw new HandshakeAbortedError(String(signal.reason ?? "aborted"));
  }
};

// Per-connection state. Aborted on disconnect and stop(), so nothing queued
// for an old connection writes to the camera after it is gone.
interface ConnectionContext {
  device: Device;
  deviceId: string;
  controller: AbortController;
  // Serializes 0x03 handshakes/rewrites: never two set-interval writes at
  // once on one connection.
  intervalQueue: Promise<void>;
}

interface CameraLinkEvents {
  // deviceId is the camera's BLE MAC with colons stripped (the server's
  // device identity, same convention as the old WiFi pipeline).
  onFrame: (frame: AssembledFrame, deviceId: string) => void;
  onStatusChange: (status: CameraLinkStatus) => void;
  onDeviceIdentified: (deviceId: string) => void;
  // Result of the capture-interval handshake (BLE doc section 3, step 4),
  // reported to the server as device info (documentation 4.8).
  onCaptureConfigReport?: (
    report: CaptureConfigReport,
    deviceId: string,
  ) => void;
}

export interface CaptureConfigReport {
  measuredAtMs: number;
  /** Written via 0x03; null = no 0x03 (old firmware or no config cache). */
  requestedIntervalMs: number | null;
  settingsFormFactor: string | null;
  /** Parsed 0004 JSON; null = characteristic missing or unreadable. */
  info: CameraDeviceInfo | null;
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
  private connection: ConnectionContext | null = null;
  private transactionCounter = 0;
  // Instance field so the Node integration test can shorten it.
  private captureIntervalTimeoutMs = CAPTURE_INTERVAL_TIMEOUT_MS;
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
    this.abortConnection("link stopped");
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
      this.abortConnection("replaced by a new connection");
      const connection: ConnectionContext = {
        device: connected,
        deviceId,
        controller: new AbortController(),
        intervalQueue: Promise.resolve(),
      };
      this.connection = connection;
      this.events.onDeviceIdentified(deviceId);

      connected.onDisconnected(() => {
        // Cancels a running handshake and queued rewrites for this
        // connection (including their in-flight BLE transactions).
        if (this.connection === connection)
          this.abortConnection("disconnected");
        this.assembler.reset();
        this.device = null;
        // The firmware falls back to its default interval on disconnect.
        this.supportsInterval = false;
        this.appliedIntervalKey = null;
        if (this.running) this.scheduleReconnect();
      });

      // The firmware starts capturing the moment a central connects (paused
      // resets on disconnect), so a paused session re-asserts pause first,
      // before the up-to-5 s interval handshake.
      if (this.desiredPaused) await this.writePausedState().catch(() => {});

      // Then device info + 0x03 (docs/ble-protocol.md section 6), then
      // frame notifications. Bounded by CAPTURE_INTERVAL_TIMEOUT_MS; on
      // timeout or disconnect the handshake is aborted (no stray writes
      // afterwards). Never aborts recording.
      await this.runCaptureIntervalStep(connection, (signal) =>
        this.applyCaptureInterval(connection, signal),
      ).catch((error: unknown) =>
        console.warn(
          "BLE capture interval handshake skipped:",
          error instanceof HandshakeAbortedError ? error.message : error,
        ),
      );

      // Disconnected or stopped meanwhile: the reconnect path takes over.
      if (connection.controller.signal.aborted) return;

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

  private abortConnection(reason: string): void {
    const connection = this.connection;
    if (!connection) return;
    this.connection = null;
    connection.controller.abort(reason);
  }

  // Runs one 0x03 step on the connection's queue with its own timeout. The
  // step's signal aborts on timeout, disconnect or stop().
  private runCaptureIntervalStep(
    connection: ConnectionContext,
    step: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const run = async () => {
      const { controller, dispose } = childController(
        connection.controller.signal,
        this.captureIntervalTimeoutMs,
      );
      try {
        await new Promise<void>((resolve, reject) => {
          // Resolve as soon as the signal aborts, even if the current BLE
          // call ignores cancellation: the next step checks the signal.
          const onAbort = () =>
            reject(
              new HandshakeAbortedError(
                String(controller.signal.reason ?? "aborted"),
              ),
            );
          if (controller.signal.aborted) return onAbort();
          controller.signal.addEventListener("abort", onAbort);
          step(controller.signal)
            .then(resolve, reject)
            .finally(() =>
              controller.signal.removeEventListener("abort", onAbort),
            );
        });
      } finally {
        dispose();
      }
    };
    const result = connection.intervalQueue.then(run);
    connection.intervalQueue = result.catch(() => {});
    return result;
  }

  // One BLE call that is cancelled (cancelTransaction) when signal aborts.
  private async bleCall<T>(
    signal: AbortSignal,
    call: (transactionId: string) => Promise<T>,
  ): Promise<T> {
    throwIfAborted(signal);
    const transactionId = `blinks-capture-${++this.transactionCounter}`;
    const onAbort = () => {
      void this.manager.cancelTransaction(transactionId).catch(() => {});
    };
    signal.addEventListener("abort", onAbort);
    try {
      return await call(transactionId);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async applyCaptureInterval(
    connection: ConnectionContext,
    signal: AbortSignal,
  ): Promise<void> {
    const { device } = connection;
    try {
      const characteristics = await this.bleCall(signal, () =>
        device.characteristicsForService(BLE_SERVICE_UUID),
      );
      const hasDeviceInfo = characteristics.some(
        (characteristic) =>
          characteristic.uuid.toLowerCase() ===
          BLE_DEVICE_INFO_CHARACTERISTIC_UUID,
      );
      const before = hasDeviceInfo
        ? await this.readDeviceInfo(device, signal)
        : null;
      throwIfAborted(signal);
      if (!before) {
        console.info(
          "BLE camera firmware has no capture-interval support; using its default.",
        );
        cameraCaptureConfigStore.set({
          deviceInfo: null,
          supportsInterval: false,
          warning: null,
        });
        this.report(device, null, null);
        return;
      }
      this.supportsInterval = true;
      console.info("BLE camera device info:", JSON.stringify(before));
      cameraCaptureConfigStore.set({
        deviceInfo: before,
        supportsInterval: true,
        warning: null,
      });
      await this.writeCaptureInterval(connection, signal);
    } catch (error) {
      if (error instanceof HandshakeAbortedError || signal.aborted) throw error;
      console.warn(
        "BLE capture interval could not be applied; camera keeps its interval:",
        error,
      );
    }
  }

  private async writeCaptureInterval(
    connection: ConnectionContext,
    signal: AbortSignal,
  ): Promise<void> {
    const { device } = connection;
    throwIfAborted(signal);
    const appState = appConfigStore.getState();
    const intervalMs = desiredCaptureIntervalMs(appState);
    const formFactor = appState.cameraFormFactor;
    if (intervalMs === null || formFactor === null) {
      // Never loaded the config (or no form factor yet): no 0x03, the camera
      // records with its firmware default.
      console.info("No cached capture interval; camera keeps its default.");
      this.report(device, null, cameraCaptureConfigStore.getState().deviceInfo);
      return;
    }
    const key = `${formFactor}:${intervalMs}`;
    // A queued rewrite whose value an earlier step already wrote: nothing to do.
    if (this.appliedIntervalKey === key) return;
    this.appliedIntervalKey = key;
    try {
      await this.bleCall(signal, (transactionId) =>
        device.writeCharacteristicWithResponseForService(
          BLE_SERVICE_UUID,
          BLE_CONTROL_CHARACTERISTIC_UUID,
          fromByteArray(encodeSetIntervalCommand(intervalMs)),
          transactionId,
        ),
      );
    } catch (error) {
      this.appliedIntervalKey = null;
      throw error;
    }
    let after: CameraDeviceInfo | null = null;
    try {
      after = await this.readDeviceInfo(device, signal);
    } catch {
      after = null;
    }
    // The 0x03 went out, so report it even if the re-read was cut off.
    this.report(device, intervalMs, after);
    throwIfAborted(signal);
    if (!after) return;
    const formFactors = appState.config?.devices.formFactors ?? [];
    const warning = cameraIntervalWarning(
      after,
      intervalMs,
      formFactor,
      (formFactorKey) =>
        formFactors.find((candidate) => candidate.key === formFactorKey)
          ?.displayLabel ?? formFactorKey,
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
    const connection = this.connection;
    if (!connection || !this.supportsInterval) return;
    const appState = appConfigStore.getState();
    const intervalMs = desiredCaptureIntervalMs(appState);
    if (intervalMs === null || appState.cameraFormFactor === null) return;
    if (
      this.appliedIntervalKey === `${appState.cameraFormFactor}:${intervalMs}`
    ) {
      return;
    }
    // Queued behind a running handshake; re-checks the key when it runs.
    void this.runCaptureIntervalStep(connection, (signal) =>
      this.writeCaptureInterval(connection, signal),
    ).catch((error) =>
      console.warn("BLE capture interval could not be rewritten:", error),
    );
  }

  private report(
    device: Device,
    requestedIntervalMs: number | null,
    info: CameraDeviceInfo | null,
  ): void {
    try {
      this.events.onCaptureConfigReport?.(
        {
          measuredAtMs: Date.now(),
          requestedIntervalMs,
          settingsFormFactor: appConfigStore.getState().cameraFormFactor,
          info,
        },
        device.id.replace(/:/g, ""),
      );
    } catch (error) {
      console.warn("Device-info report failed:", error);
    }
  }

  private async readDeviceInfo(
    device: Device,
    signal: AbortSignal,
  ): Promise<CameraDeviceInfo | null> {
    const characteristic = await this.bleCall(signal, (transactionId) =>
      device.readCharacteristicForService(
        BLE_SERVICE_UUID,
        BLE_DEVICE_INFO_CHARACTERISTIC_UUID,
        transactionId,
      ),
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
