import { fromByteArray } from "base64-js";
import { BleManager, Device } from "react-native-ble-plx";

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
// reconnection: any disconnect while running goes back to scanning.
export class CameraLink {
  private readonly manager = new BleManager();
  private readonly assembler = new FrameAssembler();
  private device: Device | null = null;
  private running = false;
  private connecting = false;
  private desiredPaused = false;

  constructor(private readonly events: CameraLinkEvents) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const subscription = this.manager.onStateChange((state) => {
      if (!this.running) {
        subscription.remove();
        return;
      }
      if (state === "PoweredOn") {
        subscription.remove();
        this.startScan();
      } else {
        this.events.onStatusChange("bluetoothOff");
      }
    }, true);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.manager.stopDeviceScan();
    await this.device?.cancelConnection().catch(() => {});
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

  private startScan(): void {
    if (!this.running) return;
    this.events.onStatusChange("scanning");
    // No UUID filter: match by advertised name (see ble-constants).
    this.manager.startDeviceScan(null, null, (error, device) => {
      if (error || !this.running) return;
      const name = device?.name ?? device?.localName;
      if (device && name === BLE_DEVICE_NAME && !this.connecting) {
        void this.connectTo(device);
      }
    });
  }

  private async connectTo(device: Device): Promise<void> {
    this.connecting = true;
    this.manager.stopDeviceScan();
    this.events.onStatusChange("connecting");
    try {
      const connected = await device.connect();
      this.device = connected;
      await connected.requestMTU(517).catch(() => {});
      await connected.discoverAllServicesAndCharacteristics();

      const deviceId = connected.id.replace(/:/g, "");
      this.events.onDeviceIdentified(deviceId);

      connected.onDisconnected(() => {
        this.assembler.reset();
        this.device = null;
        if (this.running) this.startScan();
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
    } catch {
      this.device = null;
      if (this.running) this.startScan();
    } finally {
      this.connecting = false;
    }
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
