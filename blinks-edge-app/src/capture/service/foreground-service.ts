import notifee, {
  AndroidForegroundServiceType,
  AndroidImportance,
} from "@notifee/react-native";

const CHANNEL_ID = "blinks-capture";
const NOTIFICATION_ID = "blinks-fgs";

// The foreground service is what keeps the BLE link + relay alive while the
// app is backgrounded overnight (validated in the feasibility spike). The
// connectedDevice service type matches the BLE use case and has no daily time
// cap; the config plugin plugins/with-notifee-foreground-service-type.js
// overrides notifee's manifest so Android 14+ accepts it.
export const startCaptureForegroundService = async (
  isTestRecording = false,
): Promise<void> => {
  const channelId = await notifee.createChannel({
    id: CHANNEL_ID,
    name: "BLINKS recording",
    importance: AndroidImportance.LOW,
  });
  await notifee.displayNotification({
    id: NOTIFICATION_ID,
    title: isTestRecording
      ? "BLINKS test recording"
      : "BLINKS is recording",
    body: isTestRecording
      ? "Checking the camera connection"
      : "Receiving camera frames over Bluetooth",
    android: {
      channelId,
      asForegroundService: true,
      ongoing: true,
      foregroundServiceTypes: [
        AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
      ],
      smallIcon: "ic_launcher",
      pressAction: { id: "default" },
    },
  });
};

export const stopCaptureForegroundService = async (): Promise<void> => {
  await notifee.stopForegroundService();
  await notifee.cancelNotification(NOTIFICATION_ID);
};
