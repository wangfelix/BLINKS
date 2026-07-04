// Central app configuration. The server is only reachable from inside the KIT
// network, so on a study phone the KIT OpenVPN must be active. For local
// development set EXPO_PUBLIC_SERVER_URL to the laptop's LAN address, e.g.
// EXPO_PUBLIC_SERVER_URL=http://10.0.0.5:3000 npx expo start --dev-client
const serverUrl =
  process.env.EXPO_PUBLIC_SERVER_URL ?? "http://blinks.win.kit.edu";

export const appConfig = {
  serverUrl,
  webSocketUrl: serverUrl.replace(/^http/, "ws"),
  // Fallback while GET /api/profile loads; the authoritative value is
  // profile.studyDurationDays (= the participant's DRM condition plan length).
  studyDurationDays: 4,
} as const;
