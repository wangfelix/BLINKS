// Minimal BleManager so CameraLink can be constructed in Node; tests drive
// CameraLink.finishConnection with a fake Device instead of real BLE.
export type Subscription = { remove: () => void };
export type Device = Record<string, unknown>;

// Fake devices register a cancel handler per pending transactionId;
// cancelTransaction calls it (react-native-ble-plx rejects the operation).
export const pendingTransactions = new Map<string, () => void>();
export const cancelledTransactions: string[] = [];

export class BleManager {
  onStateChange(): Subscription {
    return { remove: () => {} };
  }
  async cancelDeviceConnection() {}
  async cancelTransaction(transactionId: string) {
    cancelledTransactions.push(transactionId);
    pendingTransactions.get(transactionId)?.();
  }
  destroy() {}
  stopDeviceScan() {}
}
