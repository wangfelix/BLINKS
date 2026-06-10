# blinks-edge-app — BLINKS production app

Participant-facing Expo (Android) app for the BLINKS wearable-camera study:
BLE central + relay for the `camera-firmware/` peripheral. Connects to the
camera over BLE, stamps each frame's capture time on header receipt, and
forwards frames to the KIT-internal ingestion server over the phone's KIT VPN.
A notifee **foreground service** (type `connectedDevice`) keeps the link alive
while the app is backgrounded overnight — the mechanism validated in
`feasibility/blinks-ble-app`.

## Structure

- `src/app/` — Expo Router routes: `login`, `(tabs)/` (Dashboard / History /
  Profile behind the floating-pill tab bar), `recording` (full-screen modal),
  `session-detail`.
- `src/capture/` — the heart: `ble/` (scan/connect, tagged-frame reassembly),
  `relay/` (authenticated WebSocket uploader with in-memory queue),
  `service/` (foreground service), `model/recording-session-store.ts`
  (session state machine, lives outside React so it survives navigation and
  backgrounding).
- `src/navigation/components/custom-tab-bar/` — floating pill tab bar ported
  from the app-guards-isn sibling app (liquid glass on iOS 26+, shadowed pill
  fallback on Android; drag + tap + spring animations).
- Feature folders (`dashboard/`, `history/`, `profile/`, `authentication/`,
  `sessions/`) follow the `model/use-*-model.ts` hook pattern.

## Build (dev client — Expo Go cannot run BLE/notifee)

```bash
npm install
# local build (needs Android SDK):
npx expo run:android
# or cloud build:
npx eas build --profile development --platform android
```

Then `npm start` and open from the dev client.

For local development against a laptop server:

```bash
EXPO_PUBLIC_SERVER_URL=http://<laptop-ip>:3000 npm start
```

Without the override the app talks to `http://blinks.win.kit.edu`
(KIT-internal — phone must be on the KIT VPN).

## Critical Android plumbing (do not remove)

- `plugins/with-notifee-foreground-service-type.js` — overrides notifee's
  manifest service type to `connectedDevice`. Without it the app **crashes on
  Android 14+** (`foregroundServiceType 0x10 is not a subset of 0x800`), and
  `shortService` would be time-capped. Ported from the spike.
- BLE chunks are decoded/encoded with **base64-js** (the `buffer` package's
  base64 was rejected by Android file APIs in the spike).
- On the study phones: disable battery optimization for the app (the spike's
  overnight run died after ~3.6 h when an aggressive OEM killed the app).
