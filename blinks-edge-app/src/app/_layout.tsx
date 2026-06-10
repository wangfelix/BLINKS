import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import "react-native-reanimated";

import { AppProviders } from "@/application/providers/app-providers";
import { useAuth } from "@/authentication/context/auth-context";

void SplashScreen.preventAutoHideAsync();

const RootNavigator = () => {
  const { status } = useAuth();
  const isSignedIn = status === "signedIn";

  useEffect(() => {
    if (status !== "restoring") void SplashScreen.hideAsync();
  }, [status]);

  if (status === "restoring") return null;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={isSignedIn}>
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
