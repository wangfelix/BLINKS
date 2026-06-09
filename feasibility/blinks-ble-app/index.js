import { registerRootComponent } from "expo";
import notifee from "@notifee/react-native";
import App from "./App";

// Register the keep-alive foreground-service task BEFORE the app starts (notifee
// requires this at module load). The task just stays pending; the actual BLE
// work runs in App.tsx and survives backgrounding because the foreground
// service keeps the process alive.
notifee.registerForegroundService(() => new Promise(() => {}));

registerRootComponent(App);
