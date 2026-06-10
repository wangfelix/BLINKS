import { PermissionsAndroid, Platform } from "react-native";

// Runtime permissions for BLE scanning/connecting and the foreground-service
// notification. Mirrors the validated spike: SCAN/CONNECT on Android 12+,
// fine location on older versions, POST_NOTIFICATIONS on 13+.
export const requestCapturePermissions = async (): Promise<boolean> => {
  if (Platform.OS !== "android") return true;

  const sdkVersion = Platform.Version;
  const permissions: string[] = [];
  if (sdkVersion >= 31) {
    permissions.push(
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    );
  } else {
    permissions.push(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
  }
  if (sdkVersion >= 33) {
    permissions.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  }

  const results = await PermissionsAndroid.requestMultiple(
    permissions as Parameters<typeof PermissionsAndroid.requestMultiple>[0],
  );
  return Object.values(results).every(
    (result) => result === PermissionsAndroid.RESULTS.GRANTED,
  );
};
