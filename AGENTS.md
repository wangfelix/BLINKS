# Camera Pipeline for VLM-Based Scene Understanding

This project builds the camera data collection pipeline for a research project on **Vision Language Model (VLM) based scene understanding** as a context layer for biosignal-based studies of flow, mental effort, and knowledge work. The pipeline ingests JPEG frames from one or more wearable cameras into a central server that organises them by participant and device, with precise timestamps for later alignment with biosignals.

The work is conducted at the **Karlsruhe Institute of Technology (KIT)**, KD2School / KD2Lab, under Dr. Michael Knierim. CHI is the target publication venue.

---

## Research framing (the "roter Faden")

The conceptual core is the **interruption-measurement paradox**. Experience sampling (EMA / ESM) interrupts the very state it tries to measure, while biosignals are non-interruptive but lack contextual interpretation in the field. **VLM-based scene understanding is positioned to resolve both sides simultaneously**, by providing contextual labels for biosignal segmentation and by enabling adaptive, context-aware survey timing.

The identified gap is that no existing work uses VLM-based visual scene understanding as a context layer to address biosignal labeling ambiguity and adaptive EMA timing in parallel. The camera pipeline built here is the data-collection substrate for that contribution.

Architectural direction for the VLM component is a rolling window of **per-image scene-state descriptors** (posture, movement, screen engagement, object manipulation, proximity, social interaction) as an intermediate representation between raw embeddings and activity labels, feeding into change point detection. Activity-likelihood scores as CPD features are avoided due to circularity with downstream activity recognition.

---

## CURRENT PRIORITY — "DRM Subproject" (re-scoped 2026-06-22, build this first)

Time pressure has narrowed the study scope for now. The full adaptive-EMA version stays on the roadmap (sections below remain valid as the long-term direction), but what gets built and run **first** is a study comparing the **Day Reconstruction Method (DRM) vs. VLM-assisted DRM**. No adaptive ESM/EMA delivery, no CPD, no push notifications.

**Study design (re-scoped 2026-07-11 → SINGLE DAY, TWO ROUNDS; supersedes the earlier multi-day plan):** each participant wears the glasses for **one field day** (capture pipeline unchanged: camera → BLE → app → server → face-blur → VLM). That **same evening** they reconstruct that one day on the **website in two sequential rounds, fixed order**:

1. **Self DRM** (T1) — unassisted, from memory only. No frames, no VLM output shown.
2. **VLM-assisted DRM** (T2) — the VLM activity list + frame images; edit / confirm / add forgotten activities.

Then they do the **end-of-day surveys on LimeSurvey** (external; Flow / Workload / Mental fatigue [scales TBD], Emotions = SAM, DRM burden + completion time **per round**). It is **within-subject** (every participant does both T1 and T2 on their one day); the fixed order is deliberate — the memory-based Self DRM must be **submitted before the assisted round unlocks**, so the VLM's proposals never contaminate the from-memory recall.

- **Control arm (n = 5–8, between-subjects):** round 2 is **Self DRM again (unassisted)** instead of VLM-assisted, to estimate the *pure second-attempt / repetition effect* so the main group's T1→T2 gain can be attributed to the VLM help beyond mere repetition. So round 2's mode depends on the participant's **arm** (main = assisted, control = self-again), set at provisioning (`npm run create-user -- <u> <pw> [--arm control]`, default `main`; changeable until the participant first opens round 2 — its mode is pinned then; after that, fix via DB).
- **Timeline:** Day 0 lab onboarding (consent, receive glasses + study phone + test run; the participant enters occupation / work description / **usual wake + bed times in the app onboarding**, stored server-side); Day 1 field day + evening reconstruction; Day 2 return devices + debrief. **No biosignals in this study.** Participants are instructed in the lab to do the evening on their own; the **fallback reminder** is a single push at the reported **bedtime − 10 min** (decided 2026-07-12; replaces the earlier fixed 19:00/21:00 pair).
- **Analysis targets** (external to this repo): activity count Self vs. assisted (resolution), perceived burden per round, end-of-day fatigue vs. number/kind of breaks — the assisted round surfaces small breaks the participant would forget from memory.

**Per component (as built after the 2026-07-12 two-round rewrite):**

- **Mobile app:** the recorder, now single-day (no multi-day progress UI); onboarding collects **occupation + work description + wake/bed times** (stored server-side; occupation is the VLM's classification context, bedtime drives the fallback push). History shows frames but **never any VLM output**.
- **VLM worker (`server/vlm/`):** per frame produces (1) a **category label** `work | break | other` — `break` = intentional, restorative pause ("erholsame Pause"); `other` = neither work nor restorative (chores, answering the door, possibly cooking); classification is conditioned on the participant's occupation/work description — and (2) the **raw activity label** (free text). Descriptor stays (roadmap needs it). Untouched by the two-round rewrite.
- **Server:** stores occupation/work description/schedule + per-participant **arm**; stores **activities** (the reconstruction unit: time span + raw label + category label) keyed by **(participant, round)**; serves the order-enforcing two-round reconstruction API. **Label-quality tracking:** frame columns `user_corrected_category_label` / `user_corrected_activity_label` (NULL = never corrected), filled by propagating the submitted **assisted round only** onto the frames in each activity's time span → per-frame misclassification and wrong-activity rates fall out by comparing to `vlm_category` / `vlm_label`. Self rounds never propagate (both rounds cover the same day and would overwrite each other; the control arm's VLM-accuracy comparison runs researcher-side against its activities table).
- **Web app (`drm-web/`):** Next.js + shadcn on **blinks.win.kit.edu** next to the API. Linear pipeline: (1) landing + participant login (same credentials as the app), (2) **/reconstruct** with a "Step 1 of 2 / Step 2 of 2" header — step 1: self editor (manual time spans + labels, **no frames, no VLM output**); step 2 (unlocks on step-1 submit): assisted editor for main (rows with frames, time span, raw label, category label; delete row, insert row between, re-pick start/end frames with neighbor spans adjusting) or the self editor again for control, (3) external survey link page (placeholder URL, opens in a new tab), (4) offboarding page.

### DRM Subproject — BUILT 2026-07-05, REBUILT single-day/two-round 2026-07-12 (all checks passing)

Original build: commits `24f7b92` (server + VLM worker), `7dbd6e8` (`drm-web/`), `5100ba3` (app); its 3-lens adversarial review fixed 7 findings (critical: `export.csv` leaked `vlm_label`). The 2026-07-12 rewrite replaced the multi-day condition-plan model with the single-day two-round model across server + drm-web + app (auth / ingestion / face-blur / VLM worker / `segmentation.ts` untouched). Verified after the rewrite: server `tsc` build, 10-case segmentation unit test, rewritten end-to-end smoke test over the whole two-round surface (order gate, self/assisted leak checks, arm hiding, provenance, assisted-only propagation, submit finality, validation), `drm-web` `next build` + `tsc`, app `check-all`, plus a clicked-through browser run of both arms against seeded demo data.

Implementation decisions (beyond the spec above):

- **Activity vocabulary:** the VLM picks the closest of **44 fixed activities** (`ACTIVITY_VOCABULARY` in `server/vlm/vlm_worker.py`; may coin a concise label if nothing fits). **Review/extend the list before the study.** Category (work/break/other) is judged separately, conditioned on occupation.
- **Initial segmentation** (`server/src/segmentation.ts`, pure + unit-tested; constants `GAP_SPLIT_MS`=10 min, `MIN_SEGMENT_MS`=2 min): (1) group consecutive frames by `(category, normalized label)` — normalize = lowercase+trim+collapse-whitespace, so `work|coding` and `other|coding` are *different* keys; (2) split into blocks at capture gaps > 10 min (never merge across); (3) **smooth**: repeatedly merge any segment shorter than 2 min (or unlabeled) into a neighbor (prefer previous) until every survivor is ≥ 2 min or only one remains — on merge the **longer constituent donates the label + category** (a labeled segment always beats an unlabeled one; ties → earlier). Activity start/end = first/last frame time of the group. Generated once when the assisted round is opened with a zero VLM backlog (`face_status='failed'` frames can never become VLM-done and don't count as pending). An emptied, unsubmitted assisted draft re-proposes on reload.
  - **Key consequence (not a bug):** the 2-min floor suppresses per-frame label flicker. A run needs ~4 consecutive same-`(category,label)` frames at the 30 s study interval (or ~24 at 5 s) to survive as its own activity; anything shorter is absorbed into its neighbor, and the *longest early run's* label tends to win. A **short or flickery session collapses to one activity** — verified on a ~5 min 5 s-interval test (60 frames, labels oscillating coding/walking/coffee/…) that segmented to a single `coding or data analysis / work` row. Real days at 30 s keep genuine multi-minute activities distinct. The participant can always split via *Insert activity* / *Adjust times*. `MIN_SEGMENT_MS` is the tuning knob if real-day segments look too coarse/fine — decide after seeing a full real day.
- **Study day + rounds** (`recordings.db`): the study day = the participant's **latest local date with ≥1 frame** (env `DRM_TZ`, default Europe/Berlin) at the moment round 1 is first opened — a Day-0 lab test run is superseded once the field day produces frames. `reconstructions` is keyed `(participant, round ∈ {1,2})` and **pins `mode` + `day` on first open** so a new morning-after frame, frame deletion, or a late arm change can never shift a seen round; round 2's day always equals round 1's pinned day. `participants.arm` (`main`/`control`, default main) replaced `condition_plan`; the **clean-break migration drops old-shape DRM tables on server start** (frames + auth untouched — re-provision test users after deploying). Caveat: if a participant opens the site on Day 0 evening (post-gate) the test day gets pinned — delete their `reconstructions` rows to reset. The bedtime fallback push has the same Day-0 exposure (it fires whenever frames exist *today* and round 2 is unsubmitted, and tapping it leads straight to the site), so **delete the lab test-run frames after the Day-0 pipeline check** (per-frame delete in the app, or drop the session's rows + files on the VM).
- **API:** `GET /api/reconstruction/state` (day, counts, both rounds' status; **round 2's mode is hidden while locked** so the arm can't be inferred early), `GET/PUT /api/reconstruction/round/:round` + `POST .../submit`. **Round 2 reads AND writes 403 until round 1 is submitted** (the fixed-order invariant, server-side). Self rounds carry no `frames`, no `vlmPendingCount`, reject `source:'vlm'` rows, and strip VLM-provenance echoes; only the assisted round serves frames + VLM labels + the segmentation bootstrap.
- **Evening gate:** if the pinned/derived study day is today, the reconstruction opens at `DRM_AVAILABLE_FROM_HOUR` (default 19) local, **server-enforced on GET and writes** (404-for-no-frames before 403-for-gated); a past study day is always open (morning-after catch-up), `submitted_at` recorded per round for recall-delay analysis. **Submit is final per round** (409 after; researcher unlocks via DB, see COMMANDS.md).
- **Label-quality data:** activity rows keep the original VLM proposal (`vlm_raw_label`/`vlm_category`), echoed by the web client through span edits; on **assisted** submit each activity stamps `user_corrected_*` onto its frames (validated within-day, non-overlapping, ≤300 rows, propagation additionally clamped to the day). Self rounds (incl. both control-arm rounds) never stamp frames.
- **Web auth:** bearer token + `blinks_token` cookie accepted **only for `GET /frames/*`** (browser `<img>` can't send headers); JSON APIs stay header-only (CSRF hygiene). The web client calls `queryClient.clear()` on sign-in AND sign-out — cached rounds/frames must not survive an account switch on a shared browser (found in browser verification: a control participant briefly saw a main participant's cached assisted round), and a submitted round is never mounted in the editable editor.
- **Push reminder:** in-server scheduler (60 s tick, `DISABLE_PUSH=1` for dev), Expo push API. Single **bedtime fallback**: fires at the participant's reported bedtime − 10 min (bedtimes before noon clamp to 23:50; missing bedtime → `DRM_DEFAULT_BEDTIME`, default 22:00) when they have a token + ≥1 frame today + round 2 not submitted; dedup per day via `participants.last_reminder_day`; payload `data.url` opens the site (env `WEB_URL`). The old 19:00/21:00 pair and `last_followup_day` are gone.
- **App:** onboarding blocks the tabs only after the profile has *loaded* with occupation OR wake/bed times missing (offline never locks the recorder); wake/bed are HH:MM text inputs validated client- and server-side. Dashboard shows the single recording day (no N-day circles; `studyDurationDays` removed from `/api/profile` and `appConfig`). **expo-notifications is a new native module → the phones need a fresh dev build** (`npx expo run:android`).
- Frames processed before a participant filled in their occupation were classified with "occupation unknown" — requeue them (`UPDATE frames SET vlm_status='pending' WHERE ...`) if occupation-conditioned labels matter retroactively.

`drm-web/` deploy (VM): `cd drm-web && npm ci && npm run build`, run `next start -p 3001` under a `blinks-web` systemd unit (sketch in `drm-web/README.md`); Apache routes `/api`, `/ingest`, `/frames`, `/health` → `127.0.0.1:3000` and everything else → `127.0.0.1:3001`. Server env: `WEB_URL`, `DRM_TZ`, `DRM_AVAILABLE_FROM_HOUR`, `DRM_DEFAULT_BEDTIME`, `DISABLE_PUSH`. The frames-table migration is additive, but the two-round rewrite's DRM-table migration is a **clean break** (drops old-shape `participants`/`reconstructions`/`activities` on first start — deliberate, only test data existed).

**Local testing aids for the web app:** `drm-web` dev (`npm run dev`, port 3002) **proxies** `/api`, `/frames`, `/health` to the server via `next.config.ts` rewrites (`API_PROXY_TARGET`, default `:3000`) — so dev is same-origin like prod and there is **no CORS setup** (the documented `NEXT_PUBLIC_API_URL` cross-origin path hits CORS and fails at login; the server has no CORS headers by design). `server/scripts/seed-demo-data.ts` seeds two clickable demo participants with one fully labeled field day each — `demo`/`demo12345` (main arm) and `democtl`/`demo12345` (control arm) — so the whole two-round flow works for both arms without a camera/VLM run. Run the server with `DRM_AVAILABLE_FROM_HOUR=0` to test before 19:00. Everyday commands (create-user with `--arm`, starting servers/workers with options, DB peeks) are collected in **`COMMANDS.md`** at the repo root (tracked).

---

## Current architecture (BLE phone-relay; production stack BUILT 2026-06-10)

The original design (the XIAO joins WiFi and opens a WebSocket **directly** to the server) is **superseded**. On the `new-architecture` branch the full production stack is now implemented: fixed BLE camera firmware (`camera-firmware/`), the participant app (`blinks-edge-app/`), and the authenticated server (`server/`). The legacy WiFi firmware (`xiao-camera-ws-client/`) is kept for reference but **no longer matches the server** (the `/camera/{mac}` path and `/assign` model were removed).

### Why the pivot

The production server lives on a **dedicated KIT VM reachable only from inside the KIT network** (the perimeter firewall blocks inbound public access; the VM has routable IPs but Let's Encrypt / participants' devices on the public internet cannot reach it). KIT remote access is **OpenVPN only** (SCC: `https://www.scc.kit.edu/dienste/vpn.php`). An ESP32-S3 **cannot run an OpenVPN client**, so the camera cannot reach the server from a participant's home. A **phone can** run KIT OpenVPN.

**Decision — the phone relays.** The camera is a **BLE peripheral**; the participant's phone is the **BLE central + relay**: it connects to the camera over Bluetooth LE and forwards frames to the server over the phone's KIT VPN. This removes both the on-device-VPN problem and the WiFi-provisioning problem (the camera never joins WiFi), and fits the **wearable** use case (camera + phone move together). Data path:

**camera → BLE → phone (blinks-edge-app) → (phone's KIT OpenVPN) → server (KIT-internal).**

### Repo layout (restructured 2026-06-10, history preserved via git mv)

- `server/` — ingestion + auth + participant API (TypeScript/Express/ws; was the root `src/`). Recordings live in `server/recordings/`, the auth DB in `server/data/`.
- `server/face-blur/` — face-anonymization worker (Python; CenterFace via `deface`). Polls the DB and pixelates faces in each JPEG **in place** before the frame is ever served. Separate process, never inline with ingestion.
- `server/vlm/` — VLM scene-understanding worker (Python; KIT SCC AI toolbox, OpenAI-compatible, Gemma `kit.gemma4-31b-it`). Polls for face-anonymized frames and writes a per-image scene-state descriptor + label. Separate process; runs in parallel with face-blur but gated on `face_status='done'` so it never sees an un-anonymized face.
- `camera-firmware/` — production ESP32-S3 BLE peripheral firmware (promoted from `feasibility/esp32-ble-camera`; sketch file is `camera-firmware.ino` because Arduino requires sketch = folder name).
- `blinks-edge-app/` — production Expo (Android) participant app.
- `feasibility/` — the validated spike (`blinks-ble-app` phone side; its firmware half moved to `camera-firmware/`). Keep for reference; superseded.
- `xiao-camera-ws-client/` — legacy WiFi-direct firmware. Reference only; incompatible with the current server.

### Study + hardware decisions

- Originally planned as a **5-day study**; the current DRM subproject runs **one field day per participant** (see CURRENT PRIORITY). ~20 participants who **self-administer** (start one session per day via the app). The multi-day shape returns with the full adaptive-ESM version.
- **All participants use the same Motorola phone model**, lab-provided and **preconfigured in the lab** before handout: KIT OpenVPN set up, the app installed + logged in, participant account created on the server, and **battery optimization disabled / autostart enabled**. Uniform known-good phones remove the OEM-battery-killer variability (see feasibility). Earlier testing used a vivo X200 Pro mini (worst case for background killing).
- Camera hardware unchanged: XIAO ESP32S3 Sense + OV2640, VGA JPEG.

### Feasibility spike (`feasibility/`) — validated, learnings carried into production

Built to de-risk the make-or-break question: can an Android **foreground service** keep a BLE link alive and frames flowing while the app is backgrounded overnight?

- **BLE protocol that works:** self-syncing **tagged** notifications. Use **~180-byte chunks** (notifications near MTU-3 arrived at the phone with an EMPTY value). Encode/decode base64 with **`base64-js`**, not the `buffer` package (`buffer`'s base64 output was rejected by Android's file writer).
- **Foreground-service fix (critical, hard-won):** notifee declares its service as `0x800` (shortService) in its manifest; the app requests `connectedDevice` (`0x10`) → Android 14 crash `foregroundServiceType 0x10 is not a subset of 0x800`. The fix is a config plugin overriding notifee's service type to `connectedDevice` via `tools:replace` — in production at `blinks-edge-app/plugins/with-notifee-foreground-service-type.js`. `connectedDevice` also has **no 6 h/day cap** (unlike `dataSync`), suiting an overnight relay.
- **Overnight result (vivo):** ran ~3.6 h (2578 frames at 5 s), then **the phone killed the app** (NimBLE disconnect `reason 531 = 0x213 = HCI 0x13 "Remote User Terminated"`; the camera kept advertising fine). Conclusion: **per-phone battery whitelisting is mandatory**; the Motorola + lab-preconfig plan is the mitigation.
- **adb:** `brew install android-platform-tools`. vivo hides USB debugging (needs SIM + vivo account, or wireless debugging). Native crashes do **not** surface in Metro; `adb logcat` is the only way to see them.
- A 128-bit service UUID + name overflow the 31-byte advertising packet → the firmware advertises the **name only** (`BLINKS-CAM`); the app scans with no UUID filter and matches by name.

### Camera firmware (`camera-firmware/`) — buffer fixes APPLIED 2026-06-10, FB-OVF wedge re-fixed 2026-06-19

1. **Wedge fixed via `fb_count = 1` + `CAMERA_GRAB_WHEN_EMPTY` (2026-06-19; hardware-verified 2026-06-20, 10.4 h overnight, zero wedges).** The original `fb_count = 2` + `CAMERA_GRAB_LATEST` config wedged the driver over minutes — `esp_camera_fb_get` returned NULL (`Capture failed`) and sometimes blocked outright, freezing `loop()` with the LED stuck solid (needed a power cycle). **Correction to the original diagnosis:** the sensor + camera peripheral free-run regardless of grab mode (`grab_mode`/`fb_count` only govern buffer hand-off, NOT sensor pacing), so `cam_hal: FB-OVF` lines continue and are **benign cosmetic noise** (the driver discarding unrequested frames — exactly what slow polling wants). Do not chase FB-OVF again; the bug was the wedge, and it is gone. **The earlier "discard buffered frames" stale-frame fix and the memcpy-out-before-send fix were necessary but not sufficient** — they addressed staleness and holding the buffer during the send. A visual quirk that is NOT a bug: the LED freezes for 1–2 s during each frame send (LED is recomputed per `loop()` pass, and `sendFrame`'s chunk loop blocks `loop()` for ~0.6 s per 13 KB / ~2.6 s per 58 KB); brief fast-blink bursts = quick BLE reconnects.
2. **Stale frame fixed:** the single buffered frame is captured right after the previous cycle (up to one interval old), so the firmware discards it (`fb_get`→`fb_return`, which makes the WHEN_EMPTY driver capture one fresh frame) then `fb_get`s the fresh one. Deterministic with `fb_count = 1`.
3. **Buffer not held during send:** the JPEG is `memcpy`'d out (PSRAM via `ps_malloc`, `malloc` fallback) and the framebuffer returned **before** the multi-second BLE send.
4. **Self-heal recovery (2026-06-19):** `recoverCameraIfWedged()` deinit+reinits the driver in place after 3 consecutive NULL captures, so an unattended overnight run recovers without a physical power cycle (backstop; throttling should prevent the wedge).
5. **Pause/resume control characteristic:** writable char `...0003`; single opcode byte `0x01` pause / `0x02` resume. The **phone is the authority**: the firmware resets `paused` on disconnect and the app re-asserts the state on every (re)connect (mirrors the old server→device semantics). LED: fast ~2 Hz blink = searching, **solid = connected + paused**, slow ~1 Hz blink = recording.

**BLE protocol (must stay in sync across firmware ↔ app):**

- Service `9a8b7c6d-0001-...`, frame char `...0002` (notify), control char `...0003` (write).
- Frame framing: header `[0x01][jpeg len BE 4B][camera frame counter BE 4B]`, data `[0x02][payload ≤180 B]`. The counter lets the server detect captured-but-undelivered frames (`device_frame` gaps). Receivers that read only bytes 1–4 of the header (the old spike app) remain compatible.
- `CAPTURE_INTERVAL_MS` 5000 for bring-up, 30000 for the study. Firmware stability hardware-verified 2026-06-20 (10.4 h, no wedge, all 7,511 frames captured + sent).

### Camera→phone BLE frame loss (diagnosed 2026-06-20/22 — NEXT HARDWARE TASK, fix pending)

Overnight Motorola run (Android 13, 5 s interval, 10.4 h): the firmware captured and sent **7,511** frames flawlessly, but only **4,144 (55%) reached the server**. Loss profile (from `device_frame` gap analysis in recordings.db vs. the Arduino serial log): **scattered** single/small skips (only 21 gaps ≥10 frames all night), **uniform ~50% in every hour**, **independent of frame size** (8 KB and 58 KB frames lost at the same rate), survivors stamped at true 5 s spacing (no burst catch-up). → Whole frames are dropped on the **camera→phone BLE leg while the app is backgrounded**: Android relaxes BLE/CPU scheduling for backgrounded apps (the notifee FGS prevents *killing*, not *throttling*), and the firmware fires notifications blind (`notify()` every 8 ms, return value ignored). Delivered frames' timestamps remain trustworthy (biosignal alignment unaffected); the cost is temporal density.

Investigation/fix ladder (in order; steps 1–2 diagnose, 3+ fix):

1. **Free baselines:** (a) 10 min foreground + screen on vs. 10 min backgrounded — compares camera frame counter vs. server rows; (b) the real **30 s study interval** backgrounded (more idle per frame may already shrink loss; measure before over-engineering).
2. **Instrument:** firmware counts failed `notify()` returns per frame (NimBLE returns false when the stack buffer is full — Serial-only, no adb needed); app logs abandoned frames in `FrameAssembler` (header seen, next header before completion) — write app diagnostics to file/server, backgrounded JS `console.log` is unreliable.
3. **Main fix candidate — firmware flow control:** check `notify()`'s return and retry the same chunk after a short wait instead of fire-and-forget `delay(8)`; the firmware then self-paces to the throttled link.
4. **App:** `requestConnectionPriority(High)` after connect (ble-plx supports it on Android).
5. **Bigger chunks** (~400 B at MTU 517 → ~3× fewer notifications; re-verify the spike's empty-value-near-MTU bug stays gone) and/or a larger NimBLE buffer pool.
6. **Last resort:** ack/retransmit over the control characteristic, or switch frames to indications.

The Motorola (Android 13, the study device) exposes USB debugging normally — none of the vivo pain from the spike.

### Production app (`blinks-edge-app/`) — built 2026-06-10

Expo SDK 54 (deliberately pinned, not 56: matches the sibling app's known-good reanimated-4/worklets/liquid-glass matrix), Expo Router, TanStack Query, strict TS, arrow-function components, kebab-case files, feature folders with `model/use-*-model.ts` hooks (the app-guards-isn conventions, minus its screen-enum/config indirection — adding a screen = adding a file under `src/app/`).

- **Routes:** `login`, `(tabs)/` = Dashboard / History / Profile, `recording` (full-screen modal), `session-detail`. Auth-gated via `Stack.Protected` in `src/app/_layout.tsx`; token in SecureStore; any 401 auto-signs-out.
- **Tab bar:** the floating-pill bar ported from app-guards-isn (`src/navigation/components/custom-tab-bar/`): liquid glass on iOS 26+, shadowed pill fallback on Android, drag/tap/spring pill animations, adapted to Expo Router's `tabBar` prop (tamagui views → RN views, phosphor icons).
- **Dashboard:** single recording-day card (not started / recording / completed today), one-session-per-day gate (client-side), Start/Return-to-session button. (The multi-day progress circles were removed in the 2026-07-12 single-day rewrite.)
- **Recording screen:** full-screen, background animates green (`#15803D`) ↔ neutral (`#52525B`) on pause/resume, elapsed **active** (non-paused) time, camera/server/frame/queue status, Pause/Resume + End session. Pause = BLE control write + server `/api/pause` (+ app drops in-flight frames) — three layers, same defense-in-depth as the old pipeline.
- **History:** sessions list → frames with thumbnail (authenticated image fetch), capture time, `vlm_label` (shows "pending" until the VLM pass runs), per-frame delete (server deletes JPEG + DB row). A frame only appears once it has been face-anonymized (the server withholds `face_status != 'done'` frames); no app change was needed since the API shape is unchanged (just fewer rows until the worker catches up, normally seconds).
- **Capture core (`src/capture/`):** `recording-session-store.ts` is a module-level singleton (survives navigation/backgrounding; notifee FGS keeps JS alive) wiring `CameraLink` (BLE central, reconnect loop) → `FrameAssembler` (tagged reassembly; **stamps capture time at header receipt** — within ~100 ms of true capture since the firmware sends the header right after capture; ESP32 has no clock) → `FrameUploader` (authenticated WS, in-memory queue ≤500 frames, 3 s reconnect, 20 s heartbeat).
- **Build:** needs a dev build (BLE + notifee ≠ Expo Go): `npx expo run:android` or EAS. Dev server override: `EXPO_PUBLIC_SERVER_URL=http://<laptop-ip>:3000 npm start`. `npm run check-all` = tsc + lint (both clean). **First EAS/gradle build not yet run** — notifee 9.1.8 under RN 0.81/new-arch is the thing to watch.

### Server (`server/`) — auth + participant API + phone ingestion, built 2026-06-10

- **Auth:** separate **`server/data/auth.db`** (NOT in `recordings/` — backups/rsyncs of research data must never carry credentials). `users` (username PK = participant id, argon2id `password_hash`, `created_at`) + `auth_tokens` (sha256-hashed opaque 32-byte tokens, no expiry for the short study, revocation = row delete). Login burns comparable argon2 time for unknown users (no username oracle). Provisioning: `npm run create-user -- <username> <password> [--reset] [--arm main|control]` — no self-signup.
- **Endpoints** (bearer token; each participant sees only their own data): `POST /api/login`, `POST /api/change-password`, `GET /api/sessions` (grouped from `frames`), `GET /api/sessions/:device/:session/frames`, `DELETE /api/sessions/:device/:session/frames/:frameIndex` (JPEG + row), `GET /frames/<file_path>` (ownership-checked file serving, deliberately not `express.static`), `GET /api/export.csv?device=&session=`, `POST /api/pause`, `POST /api/resume`, `GET /health` (open).
- **Ingestion:** `WS /ingest?session=<epochSeconds>&device=<cameraId>` with `Authorization: Bearer` on the upgrade. The **phone declares the session id** (epoch of the Start tap) so BLE/WS reconnects resume the same session — frame numbering continues from `MAX(frame_index)`. Per frame: JSON `{"t":<phoneCaptureEpochMs>,"n":<cameraFrameCounter|null>}` then binary JPEG (same two-message shape as the old firmware). Paused-participant gate at ingestion unchanged. `device` = camera BLE MAC, colons stripped.
- **Removed:** `/assign`, `/devices`, the unauthenticated `/camera/{mac}` WS path, `assignments.json`. Identity comes from login now.
- Env overrides: `CAMERA_PORT`, `RECORDINGS_DIR`, `DATA_DIR`, `AUTH_DB_PATH`.
- **End-to-end smoke test** (`server/scripts/smoke-test.ts`, run via tsx against a throwaway dir; set `RECORDINGS_DIR` to the same dir as the server so the test can stand in for the face-blur worker): login, 401s, WS auth rejection, ingest, reconnect-resume, **face-anonymization serving gate** (frames withheld while pending, then visible once marked done), ownership checks, delete, pause gate, password change — **passing 2026-06-24** (gate added).

### Face anonymization (`server/face-blur/`) — built + verified 2026-06-24

Privacy step between ingestion and the VLM: **every face is pixelated before any frame is served or seen by the VLM.** A wearable always-on camera captures bystanders, so this is a data-protection requirement, not a nicety.

- **Separate Python worker**, same design rule as the VLM service: never inline with WS ingestion, so detection latency or a crash can never cost a frame. It polls `recordings.db` for `face_status='pending'` rows, detects faces, obscures them, **overwrites the original JPEG in place** (atomic temp-file + `os.replace`; no unblurred copy is ever kept), and marks the row `done`.
- **Detector:** CenterFace (the ONNX model bundled with the `deface` package, 1.4k★, MIT), run through OpenCV's DNN module on **CPU** (~30 ms/frame). Tuned for **recall over precision** (`FACE_THRESHOLD`, default 0.2 = deface's default): a missed face is a breach, a false positive just pixelates a doorknob. (`blurface` was rejected — it is MP4-only and pulls in PyTorch.)
- **Method:** mosaic/pixelate by default (`FACE_METHOD=blur` for gaussian). Recorded per frame in `face_method` (e.g. `mosaic:centerface@0.2`) for the paper's methods section.
- **Serving gate (defense in depth):** the read API only lists (`listFrames`) and serves (`GET /frames/*`) frames whose `face_status='done'`. Even in the brief pending window an unblurred frame is never exposed, including to its owner.
- **Order:** ingest → face-blur → VLM. The VLM (possibly a cloud API) therefore only ever sees anonymized images.
- **Ordering caveat:** if the worker is stopped, captured frames pile up as `pending` and stay hidden from the app until it runs — run it as a systemd service alongside `blinks` (unit in `server/face-blur/README.md`). The DB migration is additive (existing rows default to `pending`, so the worker backfills them).
- Setup/run/env in `server/face-blur/README.md`. Do **not** also `pip install opencv-python-headless` (it collides with deface's `opencv-python` and corrupts `cv2`); on a headless VM install `libgl1 libglib2.0-0` instead.

### VLM scene-understanding worker (`server/vlm/`) — built + verified 2026-06-25

The context layer: reads face-anonymized frames, sends each to a VLM, and writes a per-image **scene-state descriptor** + label + description back to the `vlm_*` columns. Sibling of the face-blur worker (same poll-process-write template); the EMA/CPD layer consumes its output.

- **Model:** the **KIT SCC AI toolbox**, an **OpenAI-compatible** endpoint (`https://ki-toolbox.scc.kit.edu/api/v1`) — the same service + API key the sibling **KARMA** project uses (`openai` client, `client.chat.completions.create`). Default model **`kit.gemma4-31b-it`** (Gemma is the vision-capable model exposed over the API; the others are text-only). The endpoint is **KIT-hosted**, so even anonymized frames stay inside KIT infrastructure (not a public cloud) — this is what resolved the cloud-VLM data-protection question.
- **Auth:** `KIT_API_KEY` + `KIT_BASE_URL` via env (loaded from a **gitignored `server/vlm/.env`** for local dev, or `EnvironmentFile=` under systemd). The key is reused from KARMA; never commit it.
- **The ordering gate is a column, not a lock.** Both workers run as independent daemons **in parallel**; this one only ever claims rows `WHERE vlm_status='pending' AND face_status='done'`, so the VLM **provably never sees an un-anonymized face** (verified: a `face_status='pending'` row is skipped). A frame can be in VLM inference while the next is still being face-blurred (pipeline parallelism).
- **Lifecycle:** `vlm_status` `pending → processing → done` (or `failed` after `VLM_MAX_RETRIES`). Claims rows as `processing` up front so a crash doesn't silently re-bill the API; **single-worker assumption** — on startup any leftover `processing` row is reclaimed to `pending` (switch to a time-based reclaim if you ever run >1 worker).
- **Descriptor (v1):** small closed-vocabulary enums (plus `unknown`) for `posture, movement, screen_engagement, object_manipulation, proximity, social_interaction`, stored as JSON in `vlm_descriptor`; `vlm_label` (2-5 words) shows in the app History. Enums live in `vlm_worker.py` (`DESCRIPTOR_ENUMS`) and are a starting point to refine for the study. The model returns JSON (often ```json-fenced); the worker slices the first `{...}` and coerces to the fixed shape.
- **Claim ordering (added 2026-07-08):** current-day-first — today's frames (in `DRM_TZ`, matching the server) are claimed before any older backlog, so an evening reconstruction is never stuck behind days of catch-up; within the backlog it's oldest-first (oldest incomplete day finishes next). Degrades to newest-first if tz data is missing. Was plain oldest-first (which put today last during a backlog — the 7pm-blocked problem).
- **Concurrency (added 2026-07-08):** the endpoint calls are I/O-bound, so the worker runs up to `VLM_CONCURRENCY` (default **8**) in parallel via an in-process thread pool. Only the network calls run in threads; **all DB reads/writes stay on the main thread** (a sqlite3 connection is not thread-shareable), so the claim stays atomic and there are no concurrent-write hazards. The KIT Gemma endpoint was measured (2026-07-08) to parallelize cleanly — flat latency (~2 s) and no 429s up to 8 concurrent, ~2.4 req/s ≈ 8.6k frames/h, ~7× the study's 10-participant-at-30 s load. **Scale via `VLM_CONCURRENCY`, NOT multiple processes** — a 2nd process would double-process (non-atomic claim) and its startup reclaim would stomp the 1st's in-flight rows; multi-process would first need an atomic `... RETURNING` claim + time-based reclaim.
- Setup/run/env/systemd in `server/vlm/README.md`. `failed` frames keep their (already anonymized) image served but get no label; requeue with `UPDATE frames SET vlm_status='pending' WHERE vlm_status='failed'` once the cause clears.

### TLS (open question)

Traffic rides inside the KIT VPN to a KIT-internal server, so the VPN already encrypts transport. Whether to also terminate TLS at Apache (Let's Encrypt HTTP-01 fails — server not publicly reachable; would need DNS-01 or a DFN/KIT cert) is an open question for the data-protection side.

### Deployment status (KIT VM, set up 2026-06-07 — needs one-time migration for the restructure)

- VM: **Ubuntu 26.04**, IPv4 `129.13.238.199`, IPv6 `2a00:1398:4:5802::20`, `root` via Felix's SSH key (admin "Jadon"). DNS **`blinks.win.kit.edu`** resolves to the VM (A + AAAA).
- Installed: **Node 22** (NodeSource), build-essential, **Apache 2.4** (`proxy`, `proxy_http`, `proxy_wstunnel`, `headers`, `ssl`, `rewrite` enabled). **ufw**: only 22/80/443 inbound; raw Node port 3000 is closed.
- Repo on **GitHub** (`github.com/wangfelix/BLINKS`, public) cloned to **`/root/BLINKS`**; runs under **systemd** unit **`blinks`** (`/etc/systemd/system/blinks.service`, `127.0.0.1:3000`, auto-restart, starts on boot).
- **One-time migration on next deploy** (the server moved from repo root to `server/`):

```bash
cd /root/BLINKS && git pull
mv recordings server/recordings              # keep existing data next to the server
# edit /etc/systemd/system/blinks.service:
#   WorkingDirectory=/root/BLINKS/server
#   ExecStart=/usr/bin/node dist/server.js   # (path unchanged relative to WorkingDirectory)
systemctl daemon-reload
cd server && npm ci && npm run build
npm run create-user -- participant1 <password>   # provision accounts
systemctl restart blinks                         # initDb ALTERs in the face_* columns on first start

# face-blur worker (Python; see server/face-blur/README.md for the systemd unit)
sudo apt-get install -y libgl1 libglib2.0-0      # OpenCV runtime libs on a headless VM
cd /root/BLINKS/server/face-blur
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
sudo cp <blinks-face-blur.service> /etc/systemd/system/   # unit in README.md
sudo systemctl daemon-reload && sudo systemctl enable --now blinks-face-blur

# VLM worker (Python; see server/vlm/README.md for the systemd unit)
cd /root/BLINKS/server/vlm
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env   # put the real KIT_API_KEY in .env (reused from KARMA)
sudo cp <blinks-vlm.service> /etc/systemd/system/        # unit in README.md
sudo systemctl daemon-reload && sudo systemctl enable --now blinks-vlm
```

- Routine deploy = `cd /root/BLINKS && git pull && cd server && npm ci && npm run build && systemctl restart blinks` (also `systemctl restart blinks-face-blur` / `blinks-vlm` if those workers changed).
- Apache vhost `blinks.conf` (port 80) reverse-proxies to `127.0.0.1:3000`. The WebSocket upgrade rule must cover **`/ingest`** (it was written for `/camera/...` — update `mod_proxy_wstunnel` matching accordingly).
- **Reachable only from inside KIT** (the pivot reason): `http://blinks.win.kit.edu/health` returns OK on VPN/KIT-internal.

---

## Hardware + Arduino IDE reference

- **XIAO ESP32S3 Sense** with OV2640 camera on the Sense extension board; PSRAM 8 MB (OPI), needed for the camera framebuffer. External IPEX antenna required for radio stability.
- Sketch folders must contain `board_config.h` (with `#define CAMERA_MODEL_XIAO_ESP32S3` active) and `camera_pins.h`, copied from the stock `CameraWebServer` example.
- `camera-firmware/` needs the **NimBLE-Arduino** library (2.x API); the legacy `xiao-camera-ws-client/` needs **WebSockets** by Markus Sattler (links2004).
- IDE settings: Board **XIAO_ESP32S3**, PSRAM **"OPI PSRAM"** (else `esp_camera_init()` fails), Partition **"Huge APP (3MB No OTA / 1MB SPIFFS)"**, Serial Monitor **115200 baud**.
- Camera config: VGA (640x480), JPEG quality 12, `CAMERA_GRAB_LATEST`, 2 PSRAM framebuffers.

---

## Verified status

- **2026-06-10: server smoke test passing end-to-end** (see server section above). `server` builds clean (`tsc`); `blinks-edge-app` passes `tsc --noEmit` + `expo lint`.
- **2026-06-24: face-blur worker verified.** CenterFace detect + mosaic + atomic in-place overwrite confirmed on a real captured frame (1 face detected at 0.47, pixelated; ~30 ms/frame on CPU). The additive DB migration adds the `face_*` columns to the existing `recordings.db` (all pre-existing rows default to `pending` for backfill). `server` still builds clean (`tsc`); the smoke test now also covers the serving gate.
- **2026-06-25: VLM worker verified.** End-to-end against the live KIT SCC AI toolbox: Gemma `kit.gemma4-31b-it` processed an anonymized frame and returned a well-formed 6-dimension descriptor + label; a `face_status='pending'` row was correctly skipped (the parallel-safety gate holds). Uses the existing `vlm_*` columns (no migration). The reused KIT key lives in the gitignored `server/vlm/.env`.
- **2026-06-20: full chain verified on hardware overnight** (camera → dev-build app on the Motorola/Android 13 → server, 10.4 h): firmware ran wedge-free (7,511 frames captured + sent, control characteristic + pause working), **but only 55% of frames reached the server** — see "Camera→phone BLE frame loss" above; that fix ladder is the open hardware task.
- **Historical (WiFi-direct dev path, before the pivot; that path is now incompatible with the server):** end-to-end verified 2026-06-06 (MAC `B8F862FC5070`) — ~1 fps frames on disk, `/assign` reassignment, pause/resume incl. server-side gate, SQLite index, status LED. Phone hotspots must be forced to 2.4 GHz (no 5 GHz on the XIAO).
- **Run the server under Node 20+** (nvm `default`). A non-interactive shell may resolve an old Node (v15) first; if `tsx`/`better-sqlite3` fail to load, pin `~/.nvm/versions/node/v20.18.0/bin` on `PATH`. (App tooling uses Node 22: `~/.nvm/versions/node/v22.22.0/bin`.)

---

## Roadmap

### Done

- BLE phone-relay architecture validated (spike) and implemented (firmware + app + server).
- Auth (argon2id users, opaque tokens), participant-scoped read/edit API, phone-as-client ingestion with phone-declared sessions and phone-stamped capture times.
- SQLite frame index (see below), pause/resume across all three layers, GDPR per-frame delete.
- **Automatic face anonymization** (`server/face-blur/`, 2026-06-24): CenterFace detect + pixelate in place before serving/VLM, with a read-API serving gate. See the Face anonymization section above.
- **VLM scene-understanding worker** (`server/vlm/`, 2026-06-25): KIT SCC AI toolbox (Gemma `kit.gemma4-31b-it`, OpenAI-compatible) writes per-image scene-state descriptors, gated on `face_status='done'`. See the VLM worker section above.

### Next

- **DRM Subproject — remaining before the study** (the two-round build itself is done, see CURRENT PRIORITY): replace `PLACEHOLDER_SURVEY_URL` in `drm-web/src/app/survey/page.tsx` with the real LimeSurvey URL; review/extend `ACTIVITY_VOCABULARY` in `server/vlm/vlm_worker.py`; fresh app dev build onto the study phones (`npx expo run:android`); VM deploy of the rewrite (clean-break DRM-table migration runs on server start — re-provision test users with `--arm` afterwards).
- **BLE frame-loss fix** (see the fix ladder in the firmware area): ~45% of frames are dropped camera→phone while the app is backgrounded; firmware flow control on `notify()` is the main candidate.
- **VM migration + first real deploy** of the restructured repo (steps above), incl. Apache `/ingest` upgrade rule, web-app routing, and participant account provisioning.
- **TLS decision** (VPN-only vs. Apache TLS with DNS-01/DFN cert) for the data-protection documentation.
- Optional hardening: disk-backed upload queue in the app (currently in-memory, bounded at 500 frames), pagination for `/api/sessions/...` (a full session day at 30 s spacing is ~2.9 k frames — fine unpaginated for v1).
- **Deferred to the full version (post-DRM):** EMA/CPD layer on the descriptor window → adaptive push; descriptor taxonomy refinement; overnight-relay re-test at the study interval.

### Storage and VLM metadata (implemented 2026-06-06; paths updated for the restructure)

- **Frames stay on the filesystem** under `server/recordings/...`. Rationale: the VLM stage reads sequentially, every image tool speaks "JPEG on disk", `rsync` backups are incremental, and GDPR erasure for a participant is a directory delete rather than a `DELETE` + `VACUUM`.
- **Frame metadata and VLM output go in SQLite** (`server/recordings/recordings.db`, single file, WAL mode, via `better-sqlite3`). The ingestion server inserts one row as it writes each JPEG. Migrate to Postgres only if ingestion / VLM / API end up on separate hosts. MongoDB is the wrong shape (structured data, hot query is an indexed time-range scan). Schema:

```sql
CREATE TABLE frames (
  -- identity / keys
  participant       TEXT    NOT NULL,            -- = username in auth.db
  device            TEXT    NOT NULL,            -- camera BLE MAC, colons stripped
  session           INTEGER NOT NULL,            -- session epoch sec (phone-declared Start tap)
  frame_index       INTEGER NOT NULL,            -- per-session server counter (resumes across reconnects)
  -- timing: alignment + ordering
  capture_epoch_ms  INTEGER NOT NULL,            -- PHONE-stamped at BLE header receipt = biosignal alignment key
  received_epoch_ms INTEGER NOT NULL,            -- server receipt (latency, fallback)
  -- locator: link to the JPEG on disk, relative to recordings/
  file_path         TEXT    NOT NULL,
  -- QA (cheap, catches dropped / corrupt frames)
  device_frame      INTEGER,                     -- camera's own counter (BLE header); gaps = captured but undelivered
  byte_length       INTEGER,
  jpeg_ok           INTEGER,                     -- 0/1 from the SOI/EOI check
  -- VLM output, filled asynchronously
  vlm_status        TEXT    NOT NULL DEFAULT 'pending',  -- pending|processing|done|failed
  vlm_model         TEXT,
  vlm_label         TEXT,
  vlm_description   TEXT,
  vlm_descriptor    TEXT,                         -- JSON: posture, movement, screen_engagement, ...
  vlm_completed_at  INTEGER,
  -- Face anonymization, filled by the face-blur worker BEFORE the frame is served
  face_status       TEXT    NOT NULL DEFAULT 'pending',  -- pending|processing|done|failed
  face_count        INTEGER,                        -- faces detected/obscured
  face_method       TEXT,                           -- e.g. 'mosaic:centerface@0.2'
  face_completed_at INTEGER,
  PRIMARY KEY (participant, device, session, frame_index)
);
CREATE INDEX idx_frames_time         ON frames (participant, capture_epoch_ms);
CREATE INDEX idx_frames_pending      ON frames (capture_epoch_ms) WHERE vlm_status  = 'pending';
CREATE INDEX idx_frames_face_pending ON frames (capture_epoch_ms) WHERE face_status = 'pending';
```

- **VLM output is inline for v1.** If multi-pass comparison (same frame, several models / prompts) is later needed, split the `vlm_*` columns into a separate `vlm_results` table keyed by `(frame, model)`; the migration is mechanical. `vlm_model` is recorded so every pass stays traceable.
- The app's read path (sessions/frames/images, all authenticated + participant-scoped) is implemented; a time-range `/api/timeline?from=&to=` endpoint (cursor-paginated) can be added for the admin panel when the VLM service lands.
- **Control-plane state stays in plain files** (`paused.json`): tiny, hand-editable, read into memory at startup. Rule of thumb: queryable data goes in the DB, a handful of keys stays a file. (`assignments.json` died with the /assign model.)
- **Credentials live in `server/data/auth.db`**, deliberately outside the recordings tree (see server section).

### VLM inference and biosignal alignment

- **VLM worker BUILT + verified 2026-06-25 (`server/vlm/`).** Reads face-anonymized frames from the DB, sends each JPEG to a VLM, and writes label / description / descriptor back. It runs **after** a frame is saved (and after face anonymization, so the VLM only ever sees the already-pixelated image), never inline with ingestion, so VLM latency or crashes never cost frames and old sessions can be re-processed with a better model or prompt. The ingestion server stays dumb (capture + persist only). It is the sibling of the face-blur worker (same poll-process-write template). See the "VLM scene-understanding worker" section under the Server area for the model + gating details.
- Alignment with biosignals (Cardioban EKG, Mendi fNIRS, planned camera-glasses frame) uses `capture_epoch_ms`. In the relay architecture this is the **phone's clock at BLE header receipt** (≤ ~100 ms after true capture at 30 s spacing — sufficient for session-level alignment; the phone is NTP-synced by Android). The Mendi raw-optical-channel question and the larger longitudinal study (questionnaires, GDPR documentation) are tracked separately.
- An internal **admin panel** to review frames + labels in time order is the read path plus a small static page. No separate backend needed.

### Adaptive EMA notifications (design decision, not yet implemented)

- **Change point detection lives in the backend, not the app.** It runs in (or right after) the VLM service: once a label + descriptor is written, CPD runs over the recent window and decides whether a sustained activity change occurred. It is never done client-side. Reasons:
  - A push that reaches a backgrounded or closed app must originate server-side (server to FCM to phone). The app is closed exactly when a prompt matters, so in-app polling cannot deliver it. Android Doze / App Standby and OEM background-killers make in-app background polling unreliable, while a high-priority FCM message punches through Doze.
  - Detection is part of the scientific method, so it belongs in one versioned implementation co-located with the descriptor pipeline (Python), reproducible and identical to offline analysis, not reimplemented in app JS over whatever happened to be in a poll window.
  - Gating (rate-limit, quiet hours, minimum inter-prompt interval, respecting a participant's paused state) is centralized server-side.
- **Delivery path:** the app obtains an Expo push token and registers it with the server (e.g. `POST /api/register-push`, authenticated, persisted per participant). On a detected sustained change the server sends a high-priority push via the Expo push service (which fronts FCM). Tapping the notification opens the app to the EMA prompt / timeline.
- **EMA trigger flow:** VLM writes label + descriptor, then CPD runs over the recent window, then on a sustained change (and not paused / not rate-limited / not in quiet hours) a high-priority push is sent and the participant is prompted. This is the concrete realisation of the "adaptive, context-aware survey timing" half of the contribution.

---

## Working style for Claude in this project

- **Never `git commit` or `git push` without asking Felix first** (rule set 2026-07-05). Make the changes, verify them, then present what would be committed and wait for the go-ahead.
- **Verify every factual / methodological claim against the actual source** (paper methods section for literature, code for engineering). Never paraphrase from memory as if citing.
- For paper drafting, follow the writing constraints set in the project description: CHI scientific style, clear "roter Faden", no em-dashes, minimal colons, precise citation practices (direct sources, never paper-of-paper). For engineering work like this pipeline, those constraints don't apply, but the verification habit does.
- Mark uncertainty explicitly (`[TBD]`, "I'm not sure about X, please verify"). Empty placeholders beat incorrect statements.
- **The stack is coupled along the data path:** camera firmware ↔ BLE protocol (UUIDs, 9-byte header, opcodes) ↔ `blinks-edge-app/src/capture/` ↔ server `/ingest` + API ↔ `blinks-edge-app/src/sessions/` types. If one side changes framing, identifiers, or the phone→server protocol, update the others in the same change (the app keeps API shapes in `src/sessions/types/session-types.ts`).
- **The face-blur worker couples to the server via the DB, not a wire protocol** (the same contract the VLM service will use): `server/face-blur/blur_worker.py` owns the `face_status` lifecycle (`pending`→`done`/`failed`), and the server's serving gate reads it in two places — the `listFrames` `WHERE face_status='done'` filter and the `getFrameStatusByPath` check in the `GET /frames/*` route (`server/src/db.ts`, `server/src/server.ts`). Change the status values or the gate in those three spots together.
- App conventions: kebab-case files, feature folders with `model/use-*-model.ts` hooks, arrow-function components, TanStack Query for all server calls, strict TS. No screen-enum/config indirection — a new screen is a new file under `src/app/`.

---

## Quick reference

Server (from `server/`):

```bash
npm install
npm run dev                                   # tsx watch, port 3000
npm run build && npm start                    # production
npm run create-user -- participant1 <pw>      # provision a participant
npm run create-user -- participant1 <pw> --reset
npx tsx scripts/smoke-test.ts                 # against a running server (see script header)
```

Face-blur worker (from `server/`, a **separate Python process** — `npm run dev` does NOT start it; for local dev run it in a second terminal or the app shows no frames, since the serving gate hides un-anonymized frames):

```bash
cd face-blur && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   # one-time
.venv/bin/python blur_worker.py               # daemon: poll + anonymize forever (run alongside the server)
.venv/bin/python blur_worker.py --once        # process the current backlog, then exit
# headless VM only, if `import cv2` fails: sudo apt-get install -y libgl1 libglib2.0-0
# env knobs: FACE_THRESHOLD (default 0.2, lower = safer) FACE_METHOD=mosaic|blur — see face-blur/README.md
```

VLM worker (from `server/`, a **separate Python process**; processes only frames the face-blur worker has marked `done`):

```bash
cd vlm && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   # one-time
cp .env.example .env                          # then put the real KIT_API_KEY in .env (gitignored)
.venv/bin/python vlm_worker.py                # daemon: poll + describe forever
.venv/bin/python vlm_worker.py --once         # process the current backlog, then exit
# model defaults to kit.gemma4-31b-it via the KIT SCC AI toolbox — see vlm/README.md
```

App (from `blinks-edge-app/`):

```bash
npm install
npx expo run:android                          # dev build (BLE/notifee need it; not Expo Go)
EXPO_PUBLIC_SERVER_URL=http://<laptop-ip>:3000 npm start
npm run check-all                             # tsc + lint
```

API (all but /health need `Authorization: Bearer <token>`):

```bash
curl -X POST http://localhost:3000/api/login -H 'Content-Type: application/json' \
  -d '{"username":"participant1","password":"<pw>"}'
curl http://localhost:3000/api/sessions -H "Authorization: Bearer $TOKEN"
curl -X POST http://localhost:3000/api/pause  -H "Authorization: Bearer $TOKEN"
curl -X POST http://localhost:3000/api/resume -H "Authorization: Bearer $TOKEN"
curl "http://localhost:3000/api/export.csv?device=<id>&session=<epoch>" -H "Authorization: Bearer $TOKEN"
```

Find the laptop IP for `EXPO_PUBLIC_SERVER_URL` during LAN development:

```bash
ipconfig getifaddr en0
```

Serial Monitor baud rate: **115200**. Firmware capture interval: `CAPTURE_INTERVAL_MS` in `camera-firmware/camera-firmware.ino` (5 s bring-up / 30 s study).
