import { fromByteArray } from "base64-js";
import {
  BleManager,
  type Device,
  type Subscription,
} from "react-native-ble-plx";

import {
  BLE_CONTROL_CHARACTERISTIC_UUID,
  BLE_DEVICE_NAME,
  BLE_FRAME_CHARACTERISTIC_UUID,
  BLE_SERVICE_UUID,
  CONTROL_OPCODE_PAUSE,
  CONTROL_OPCODE_RESUME,
} from "@/capture/ble/ble-constants";
import { AssembledFrame, FrameAssembler } from "@/capture/ble/frame-assembler";

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
  private scanRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private scanRetryMs = SCAN_RETRY_INITIAL_MS;

  constructor(private readonly events: CameraLinkEvents) {}

  start(): void {
    if (this.running) return;
    this.running = true;
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
      this.scanRetryMs = SCAN_RETRY_INITIAL_MS;
      this.clearReconnectTimer();

      const deviceId = connected.id.replace(/:/g, "");
      this.events.onDeviceIdentified(deviceId);

      connected.onDisconnected(() => {
        this.assembler.reset();
        this.device = null;
        if (this.running) this.scheduleReconnect();
      });

      connected.monitorCharacteristicForService(
        BLE_SERVICE_UUID,
        BLE_FRAME_CHARACTERISTIC_UUID,
        (error, characteristic) => {
          if (error || !characteristic?.value) return;
          const frame = this.assembler.push(characteristic.value);
          if (frame) this.events.onFrame(frame, deviceId);
        },
      );

      // The firmware starts capturing the moment a central connects, so a
      // paused session must re-assert pause before frames pile up.
      if (this.desiredPaused) await this.writePausedState().catch(() => {});

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
