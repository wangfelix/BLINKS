import Constants from "expo-constants";
import * as Linking from "expo-linking";
import * as Notifications from "expo-notifications";
import { useEffect, useRef } from "react";
import { Platform } from "react-native";

import { useAuth } from "@/authentication/context/auth-context";
import { registerPushToken } from "@/notifications/api/notifications-api";

const REGISTRATION_RETRY_MS = 60_000;

// Show reminders even while the app is foregrounded (without a handler,
// foreground notifications are silently dropped).
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

const registerForPushNotifications = async (): Promise<void> => {
  if (Platform.OS === "android") {
    // Android 8+ needs a channel; the Expo push service targets "default"
    // when the server message specifies none.
    await Notifications.setNotificationChannelAsync("default", {
      name: "Study reminders",
      importance: Notifications.AndroidImportance.HIGH,
    });
  }

  let permissionStatus = (await Notifications.getPermissionsAsync()).status;
  if (permissionStatus !== "granted") {
    permissionStatus = (await Notifications.requestPermissionsAsync()).status;
  }
  if (permissionStatus !== "granted") {
    console.warn("[push] notification permission not granted, skipping");
    return;
  }

  const projectId: string | undefined =
    Constants.expoConfig?.extra?.eas?.projectId;
  const pushToken = await Notifications.getExpoPushTokenAsync(
    projectId ? { projectId } : undefined,
  );
  await registerPushToken(pushToken.data);
};

// Registers the Expo push token with the server after sign-in (and on app
// start when already signed in) and opens the DRM website when the
// participant taps a reminder (the server puts the URL in data.url). Both are
// best effort: failures are logged, never surfaced or blocking.
export const usePushNotifications = () => {
  const { status } = useAuth();
  const isSignedIn = status === "signedIn";
  const hasRegisteredRef = useRef(false);
  // A cold-start tap surfaces via getLastNotificationResponseAsync AND (on
  // some platform/version combinations) the response listener — dedupe so the
  // website is not opened twice.
  const handledNotificationIdsRef = useRef(new Set<string>());

  useEffect(() => {
    if (!isSignedIn) {
      hasRegisteredRef.current = false;
      return;
    }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const register = async () => {
      if (hasRegisteredRef.current) return;
      hasRegisteredRef.current = true;
      try {
        await registerForPushNotifications();
      } catch (error) {
        console.warn("[push] registration failed", error);
        hasRegisteredRef.current = false;
        if (!cancelled) {
          retryTimer = setTimeout(() => {
            void register();
          }, REGISTRATION_RETRY_MS);
        }
      }
    };

    void register();
    return () => {
      cancelled = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [isSignedIn]);

  useEffect(() => {
    const handleResponse = (response: Notifications.NotificationResponse) => {
      const notificationId = response.notification.request.identifier;
      if (handledNotificationIdsRef.current.has(notificationId)) return;
      handledNotificationIdsRef.current.add(notificationId);

      const url: unknown = response.notification.request.content.data?.url;
      if (typeof url === "string") {
        Linking.openURL(url).catch((error) => {
          console.warn("[push] opening notification url failed", error);
        });
      }
    };

    // Notification tap that launched the app (listener not yet attached then).
    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (response) handleResponse(response);
      })
      .catch(() => {});

    const subscription =
      Notifications.addNotificationResponseReceivedListener(handleResponse);
    return () => subscription.remove();
  }, []);
};
