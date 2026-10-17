// Minimal BleManager so CameraLink can be constructed in Node; tests drive
// CameraLink.finishConnection with a fake Device instead of real BLE.
export type Subscription = { remove: () => void };
export type Device = Record<string, unknown>;
export class BleManager {
  onStateChange(): Subscription {
    return { remove: () => {} };
  }
  async cancelDeviceConnection() {}
  destroy() {}
  stopDeviceScan() {}
}
