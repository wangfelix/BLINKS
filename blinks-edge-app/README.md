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
  Profile behind the floating-pill tab bar), `study-settings` (PIN-protected
  camera type, device-local rotation, and lab test recording), `recording`
  (full-screen modal), and `session-detail`.
- `src/capture/` — the heart: `ble/` (scan/connect, tagged-frame reassembly),
  `relay/` (authenticated WebSocket uploader with in-memory queue),
  `service/` (foreground service), `model/recording-session-store.ts`
  (session state machine, lives outside React for navigation/backgrounding and
  restores an unfinished per-user session after process termination).
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
EXPO_PUBLIC_STUDY_SETTINGS_PIN=2626 npm start
```

Without the override the app talks to `https://blinks.win.kit.edu`
(KIT-internal — phone must be on the KIT VPN).

`EXPO_PUBLIC_STUDY_SETTINGS_PIN` controls access to the Study Settings page and
defaults to `2626`. It is bundled into the participant app and is therefore an
access deterrent, not a server-side security secret. The server still requires
the participant's authenticated session for every persisted settings change.

## Recording restoration

Each participant has one recording session. The app stores a compact active
session snapshot in SecureStore and refreshes it every 30 seconds. On login or
app reopening it reconciles that snapshot with `GET /api/recording/state`, then
recreates the foreground service, BLE link, and WebSocket uploader with the
original session ID. The server continues frame numbering for that ID. Closing
the app therefore creates a capture gap but not a second session; only **End
session** makes the session final. To prevent accidental early completion, the
button is disabled until 19:00 on the phone-local date when the session started,
then remains available after midnight and requires an explicit permanent-end
confirmation.

## Lab test recording

Before the main study session starts, Profile → **Study Settings** offers
**Start test recording**. The test uses the same camera connection, foreground
service, frame relay, pause/resume controls, and recording screen, but it is
visibly marked as a test and may be ended at any time. Test JPEGs go to
`<recordings>/<participant>/Test/<device>/<session>/images/` on the server.
They do not enter `recordings.db`, the Photos tab, face-blur/VLM processing,
reminders, or the participant's one-session study state. Ending the test returns
the capture store to idle so the normal Start Session action remains available.
Tests may be repeated before the main session; an interrupted test is not
restored after an app-process restart.

## Camera image rotation

Study Settings stores a device-local clockwise rotation (`None`, `90°`, `180°`,
or `270°`) in SecureStore. The recorder reads the current selection for each
newly received frame, so a change during a study or test recording affects the
next camera image immediately. Each assembled BLE JPEG is rotated on the phone
before it enters the WebSocket upload queue; `None` bypasses decoding and
re-encoding. Both recording types use the same orientation-correction path.

## Camera form factor

After entering the Study Settings PIN, the research team selects **Necklace**
or **Glasses**. The app saves the choice immediately to
`participants.camera_form_factor` in `recordings.db`; it may be corrected at
any time because one participant keeps the same physical enclosure throughout
the study. Existing participants remain `NULL` until explicitly classified.
The research admin's Participants table can filter or export this column.

## Critical Android plumbing (do not remove)

- `plugins/with-notifee-foreground-service-type.js` — overrides notifee's
  manifest service type to `connectedDevice`. Without it the app **crashes on
  Android 14+** (`foregroundServiceType 0x10 is not a subset of 0x800`), and
  `shortService` would be time-capped. Ported from the spike.
- BLE chunks are decoded/encoded with **base64-js** (the `buffer` package's
  base64 was rejected by Android file APIs in the spike).
- Image rotation uses `expo-file-system` and `expo-image-manipulator`; adding
  these native modules requires a fresh dev/preview build.
- On the study phones: disable battery optimization for the app (the spike's
  overnight run died after ~3.6 h when an aggressive OEM killed the app).
