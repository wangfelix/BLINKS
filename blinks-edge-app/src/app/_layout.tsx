import { useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import "react-native-reanimated";

import { AppProviders } from "@/application/providers/app-providers";
import { useAuth } from "@/authentication/context/auth-context";
import { usePushNotifications } from "@/notifications/model/use-push-notifications";
import { profileQueryOptions } from "@/profile/query-options/profile-queries";

void SplashScreen.preventAutoHideAsync();

const RootNavigator = () => {
  const { status } = useAuth();
  const isSignedIn = status === "signedIn";

  usePushNotifications();

  // Block the main app until the participant has provided an occupation (the
  // AI assistant needs it as classification context). Unknown while the
  // profile is loading (or unreachable) — then the tabs stay up and the guard
  // flips as soon as the profile arrives without an occupation.
  const profileQuery = useQuery({
    ...profileQueryOptions(),
    enabled: isSignedIn,
  });
  const needsOnboarding =
    isSignedIn &&
    profileQuery.data !== undefined &&
    !(profileQuery.data.occupation ?? "").trim();

  useEffect(() => {
    if (status !== "restoring") void SplashScreen.hideAsync();
  }, [status]);

  if (status === "restoring") return null;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={isSignedIn && !needsOnboarding}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="recording"
          options={{
            presentation: "fullScreenModal",
            gestureEnabled: false,
            animation: "fade",
          }}
        />
        <Stack.Screen name="session-detail" options={{ headerShown: true }} />
      </Stack.Protected>
      <Stack.Protected guard={needsOnboarding}>
        <Stack.Screen name="onboarding" />
      </Stack.Protected>
      <Stack.Protected guard={!isSignedIn}>
        <Stack.Screen name="login" />
      </Stack.Protected>
    </Stack>
  );
};

const RootLayout = () => (
  <GestureHandlerRootView style={{ flex: 1 }}>
    <AppProviders>
      <RootNavigator />
      <StatusBar style="auto" />
    </AppProviders>
  </GestureHandlerRootView>
);

export default RootLayout;
