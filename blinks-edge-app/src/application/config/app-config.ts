// Central app configuration. The production server is reachable over HTTPS at
// blinks.win.kit.edu; webSocketUrl below therefore resolves to wss://. For
// local development set EXPO_PUBLIC_SERVER_URL to the laptop's LAN address, e.g.
// EXPO_PUBLIC_SERVER_URL=http://10.0.0.5:3000 npx expo start --dev-client
const serverUrl =
  process.env.EXPO_PUBLIC_SERVER_URL ?? "https://blinks.win.kit.edu";
const configuredStudySettingsPin =
  process.env.EXPO_PUBLIC_STUDY_SETTINGS_PIN?.trim() ?? "";
const studySettingsPin = /^\d{4,8}$/.test(configuredStudySettingsPin)
  ? configuredStudySettingsPin
  : "2626";

export const appConfig = {
  serverUrl,
  webSocketUrl: serverUrl.replace(/^http/, "ws"),
  studySettingsPin,
} as const;
