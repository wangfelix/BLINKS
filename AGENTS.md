# Camera Pipeline for VLM-Based Scene Understanding

This project builds the camera data collection pipeline for a research project on **Vision Language Model (VLM) based scene understanding** as a context layer for biosignal-based studies of flow, mental effort, and knowledge work. The pipeline ingests JPEG frames from one or more wearable cameras into a central server that organises them by participant and device, with precise timestamps for later alignment with biosignals.

The work is conducted at the **Karlsruhe Institute of Technology (KIT)**, KD2School / KD2Lab, under Dr. Michael Knierim. CHI is the target publication venue.

---

## Research framing (the "roter Faden")

The conceptual core is the **interruption-measurement paradox**. Experience sampling (EMA / ESM) interrupts the very state it tries to measure, while biosignals are non-interruptive but lack contextual interpretation in the field. **VLM-based scene understanding is positioned to resolve both sides simultaneously**, by providing contextual labels for biosignal segmentation and by enabling adaptive, context-aware survey timing.

The identified gap is that no existing work uses VLM-based visual scene understanding as a context layer to address biosignal labeling ambiguity and adaptive EMA timing in parallel. The camera pipeline built here is the data-collection substrate for that contribution.

For the current DRM study, the VLM output is deliberately narrow: complete
probability distributions over a visually grounded activity enum and the
independently inferred `work | break | other` categories for each clock-aligned
5-minute chunk. Scene-setting, descriptions, and posture/movement vectors are
neither inferred nor stored. Any future adaptive-EMA/CPD representation
requires a separate design decision after the DRM study.

---

## CURRENT PRIORITY — "DRM Subproject" (re-scoped 2026-06-22, build this first)

Time pressure has narrowed the study scope for now. The full adaptive-EMA version stays on the roadmap (sections below remain valid as the long-term direction), but what gets built and run **first** is a study comparing the **Day Reconstruction Method (DRM) vs. VLM-assisted DRM**. There is no adaptive ESM/EMA delivery or CPD; the only push notification is the single bedtime fallback reminder described below.

**Study design (re-scoped 2026-07-11 → SINGLE DAY, TWO ROUNDS; supersedes the earlier multi-day plan):** each participant wears the glasses for **one field day** (capture pipeline unchanged: camera → BLE → app → server → face-blur → VLM). That **same evening** they reconstruct that one day on the **website in two sequential rounds, fixed order**:

1. **Self DRM** (T1) — unassisted, from memory only. No frames, no VLM output shown.
2. **VLM-assisted DRM** (T2) — the VLM activity list + frame images; edit / confirm / add forgotten activities.

Then they do the **end-of-day surveys on LimeSurvey** (external; Flow / Workload / Mental fatigue [scales TBD], Emotions = SAM, DRM burden + completion time **per round**). It is **within-subject** (every participant does both T1 and T2 on their one day); the fixed order is deliberate — the memory-based Self DRM must be **submitted before the assisted round unlocks**, so the VLM's proposals never contaminate the from-memory recall.

- **No control arm:** the previously considered round-2 self-only/control path is retired and is not part of the planned study workflow. Every participant follows the same fixed sequence: round 1 Self DRM, then round 2 VLM-assisted DRM. Therefore every completed participant/day has exactly three logical lists: the round-1 `self` response, the immutable round-2 `vlm_proposal`, and the editable/final round-2 `assisted` response.
- **Timeline:** Day 0 lab onboarding (consent, receive glasses + study phone + test run; the participant enters occupation / work description / **usual wake + bed times in the app onboarding**, stored server-side); Day 1 field day + evening reconstruction; Day 2 return devices + debrief. **No biosignals in this study.** Participants are instructed in the lab to do the evening on their own; the **fallback reminder** is a single push at the reported **bedtime − 10 min** (decided 2026-07-12; replaces the earlier fixed 19:00/21:00 pair).
- **Analysis targets** (external to this repo): activity count Self vs. assisted (resolution), perceived burden per round, end-of-day fatigue vs. number/kind of breaks — the assisted round surfaces small breaks the participant would forget from memory.

**Per component (as built after the 2026-07-12 two-round rewrite):**

- **Mobile app:** the recorder, now single-day (no multi-day progress UI); onboarding collects **occupation + work description + wake/bed times** (stored server-side; occupation is the VLM's classification context, bedtime drives the fallback push). History shows frames but **never any VLM output**.
- **VLM worker (`server/vlm/`):** per **5-minute chunk** elicits two complete verbalized probability distributions: all 17 closed, visually grounded activity enums and the independent categories `work | break | other`. The worker derives both stored labels by deterministic argmax and stores both maximum probabilities and both full normalized dictionaries. `break` = intentional, restorative pause ("erholsame Pause"); `other` = neither work nor restorative. The prompt adapts Wang et al., *Calibrating Verbalized Probabilities for Large Language Models* (arXiv:2410.06707v1): determine the label internally, assess confidence, return the full distribution, and constrain the output. It uses strict JSON Schema rather than the paper's Python-dict example, returns only the two distributions, and defaults to temperature 0. Local validation requires exact key sets, values in `[0,1]`, and an approximate sum of 1 before exact normalization. These black-box self-assessments are not calibrated probabilities; the paper supports the elicitation method, not this VLM's calibration, the intervention's validity, or the `0.8` threshold. Category classification is conditioned on the participant's occupation/work description. No scene setting, description, or descriptor/vector is inferred or stored.
- **Server:** stores occupation/work description/schedule and three explicitly identified activity lists for every study day: round-1 `self`, round-2 immutable `vlm_proposal`, and round-2 editable/final `assisted`. `activity_lists.id` is the stable list-level identity; the parent stores pinned day, list `kind`, immutability, workflow status, and timing, while each child references it through `activities.activity_list_id`. `kind` is the sole workflow discriminator: `self | vlm_proposal | assisted`; `vlm_proposal` is a list role, not a participant interaction mode. The redundant `mode` column and API field were removed on 2026-07-25. The round-2 API reads, saves, and submits only the editable `assisted` list; a ready response also exposes the immutable proposal as a separate snapshot, and the complete proposal remains unchanged after edits. Label-quality analysis compares the immutable proposal activities with the submitted assisted activities; corrected labels are not duplicated onto frames or chunks.
- **Web app (`drm-web/`):** Next.js + shadcn on **blinks.win.kit.edu** next to the API. Linear pipeline: (1) landing + participant login (same credentials as the app), (2) **/reconstruct** with a "Step 1 of 2 / Step 2 of 2" header — step 1: self editor (manual time spans + activity/category dropdowns, **no frames, no VLM output**); step 2 (unlocks on step-1 submit): assisted editor (rows with frames, time span, the same activity/category dropdowns; delete row, insert row between, re-pick start/end frames with neighbor spans adjusting), (3) embedded LimeSurvey questionnaire at `survey.win.kit.edu`, with the authenticated username appended as `participantId` and a new-tab fallback, (4) offboarding page.

### DRM Subproject — BUILT 2026-07-05, REBUILT single-day/two-round 2026-07-12 (all checks passing)

Original build: commits `24f7b92` (server + VLM worker), `7dbd6e8` (`drm-web/`), `5100ba3` (app); its 3-lens adversarial review fixed 7 findings (critical: `export.csv` leaked `vlm_label`). The 2026-07-12 rewrite replaced the multi-day condition-plan model with the single-day two-round model across server + drm-web + app (auth / ingestion / face-blur / VLM worker / `segmentation.ts` untouched). The earlier two-arm implementation and tests are historical; the planned workflow now always uses self round 1 and assisted round 2.

Implementation decisions (beyond the spec above):

- **Activity vocabulary:** the VLM and participants both choose from the same **17 fixed activities**. Internal enum keys live in `server/src/activity-vocabulary.ts`, participant-facing labels in `drm-web/src/lib/activity-vocabulary.ts`, and VLM definitions in `server/vlm/vlm_worker.py`. `other` covers a visible activity outside the taxonomy; `unclear` covers insufficient visual evidence. Category (`work | break | other`) is judged separately and may encode intent; the activity enum must not.
- **Initial segmentation** (`server/src/segmentation.ts`, pure + unit-tested): input is every clock-aligned **5-minute chunk** on the day. Activities use complete chunk boundaries. Successive available chunks merge only when both `(category, normalized activity enum)` match; normalization is the defensive lowercase+trim+collapse-whitespace fallback. Missing capture periods receive no special split, so matching chunks on either side merge into one span. The activity stores the unweighted mean argmax probability and mean full probability dictionary for both activity and category over its chunks. Every failed/unlabelled chunk remains its own persisted blank activity row with no preselected activity/category, while `chunks.status='failed'` remains available for failure-rate analysis. There is no minimum-duration smoothing or neighbor absorption. Only after the participant's latest `recording_events` row is `end` for a session represented on the pinned day and every chunk is `done|failed`, segmentation creates the immutable `vlm_proposal` exactly once and initializes the editable `assisted` list from it. Emptying an unsubmitted assisted draft restores a copy of the stored proposal on reload; segmentation does not run again.
- **Study day + rounds** (`recordings.db`): the study day = the participant's **latest local date with ≥1 frame** (env `DRM_TZ`, default Europe/Berlin) at the moment round 1 is first opened — a Day-0 lab test run is superseded once the field day produces frames. The participant-facing response list (`kind=self` for round 1, `kind=assisted` for round 2) **pins its `day` on first open**, even while it has zero activity children, so a new morning-after frame or frame deletion cannot shift a seen round; round 2 derives the same pinned day from round 1. There is no separate `reconstructions` table. `participants.arm` may remain in upgraded databases only as an ignored legacy column; it does not select the workflow. Caveat: if a participant opens the site on Day 0 evening, delete that participant's `activity_lists` rows (children cascade) to reset the pinned test day. The bedtime fallback push has the same Day-0 exposure, so **delete the lab test-run frames after the Day-0 pipeline check**.
- **API:** `GET /api/reconstruction/state` (day, counts, both rounds' status), `GET/PUT /api/reconstruction/round/:round` + `POST .../submit`. The API no longer exposes `mode`. **Round 2 reads AND writes 403 until round 1 is submitted** (the fixed-order invariant, server-side). Round 1 carries no `frames`, no `vlmPendingCount`, rejects `source:'vlm'` rows, and strips VLM-provenance echoes; round 2 serves frames + VLM labels + the segmentation bootstrap.
- **Photo management and frame contract (added 2026-07-28, restored and regression-tested 2026-07-30):** photo access starts only after round 1 is submitted. `GET /api/photos` returns every frame row on the pinned study day for the navbar's **Manage Photos** gallery, while **View all photos** and thumbnail clicks open the same shared gallery scoped to an activity. Round-2 and photo responses identify every frame with `device`, `session`, and `frameIndex`, plus `captureEpochMs`, nullable `imageUrl`, and `deletedAt`. Single and bounded multi-delete remove the JPEG, clear its serving path, and retain the database row as a timestamped tombstone; the UI also supports conventional anchor-based Shift selection across an inclusive range of live frames, skipping deleted placeholders. Tombstones preserve chronology, activity boundaries, and deleted-photo counts, but never expose a cleared path or image.
- **Three-list persistence (added and consolidated 2026-07-25; mode removed 2026-07-25):** `activity_lists.id` is a surrogate primary key. Every participant/day maps to exactly one round-1 `kind=self` response list, one immutable round-2 `kind=vlm_proposal` list, and one editable/final round-2 `kind=assisted` response list. Status/timing live only on the response list; proposal exposure lives only on the immutable proposal. Child activities carry only the `activity_list_id` foreign key (`ON DELETE CASCADE`). Draft PUT and submit replace only response-list children. Existing natural-key, pre-list, separate-`reconstructions`, and mode-bearing parent schemas migrate transactionally; legacy round-2 self responses become `kind=assisted` while stable parent IDs, child rows, workflow state, and timing are preserved. Row/foreign-key checks run before obsolete tables are dropped.
- **Elapsed reconstruction timing (added 2026-07-25):** round 1 elapsed reconstruction duration = `submitted_at - first_opened_at`; round 2 VLM-proposal correction duration = `submitted_at - proposal_viewed_at`. Both are elapsed time and may include pauses. `proposal_viewed_at` is distinct from round 2 `first_opened_at`: if round 2 is first opened while VLM processing is still pending, `first_opened_at` is recorded on the empty/editable `assisted` response list for that successful pending response, while `proposal_viewed_at` is recorded only on the immutable `vlm_proposal` list when the ready proposal is actually returned. `first_draft_saved_at`, `last_draft_saved_at`, and `submitted_at` also live on the response list.
- **Experience ratings (added 2026-07-19):** every work/break activity carries a **7-point Likert** answer, collected per activity in both rounds — work: mental demand; break: mental recovery; `other` is not rated. Stored as `workload_rating`/`recovery_rating`; only the rating matching the final category is required to submit, enforced client- and server-side.
- **Evening gate:** if the pinned/derived study day is today, the reconstruction opens at `DRM_AVAILABLE_FROM_HOUR` (default 19) local, **server-enforced on GET and writes** (404-for-no-frames before 403-for-gated); a past study day is always open (morning-after catch-up), `submitted_at` recorded per round for recall-delay analysis. **Submit is final per round** (409 after; researcher unlocks via DB, see COMMANDS.md).
- **Label-quality and overreliance data:** the complete genuine VLM result lives in the immutable `vlm_proposal` list and the submitted participant result lives in the `assisted` list. After segmentation, `ceil(10% × valid VLM-labelled activities)` of the highest mean-confidence activities at or above `0.8` are selected; if none reaches `0.8`, the single highest-confidence valid activity is selected, and rows are never backfilled below the threshold. Each selected row receives a uniformly random different activity label and different category for initial presentation. Proposal `raw_label/category_label` always equal its genuine `vlm_raw_label/vlm_category`; `presented_raw_label/presented_category_label` and `is_incorrect_annotation_injected` preserve what was shown. The assisted row begins with the presented annotation and retains genuine VLM provenance through `proposal_activity_id`. Production APIs expose neither the genuine hidden annotation nor the injection marker; `DRM_DEV_MODE=1` exposes only the marker so the web app highlights injected rows light yellow. The landing page explicitly warns participants that some Step-2 labels/types are deliberately incorrect. No `user_corrected_*` copy is stored on frames or chunks.
- **Web auth:** bearer token + `blinks_token` cookie accepted **only for `GET /frames/*`** (browser `<img>` can't send headers); JSON APIs stay header-only (CSRF hygiene). The web client calls `queryClient.clear()` on sign-in AND sign-out — cached rounds/frames must not survive an account switch on a shared browser (found in browser verification: one participant briefly saw another participant's cached assisted round), and a submitted round is never mounted in the editable editor.
- **Push reminder:** in-server scheduler (60 s tick, `DISABLE_PUSH=1` for dev), Expo push API. Single **bedtime fallback**: fires at the participant's reported bedtime − 10 min (bedtimes before noon clamp to 23:50; missing bedtime → `DRM_DEFAULT_BEDTIME`, default 22:00) when they have a token + ≥1 frame today + round 2 not submitted; dedup per day via `participants.last_reminder_day`; payload `data.url` opens the site (env `WEB_URL`). The old 19:00/21:00 pair and `last_followup_day` are gone.
- **App:** onboarding blocks the tabs only after the profile has *loaded* with occupation OR wake/bed times missing (offline never locks the recorder); wake/bed are HH:MM text inputs validated client- and server-side. Dashboard shows the single recording day (no N-day circles; `studyDurationDays` removed from `/api/profile` and `appConfig`). **expo-notifications is a new native module → the phones need a fresh dev build** (`npx expo run:android`).
- Chunks processed before a participant filled in their occupation were classified with "occupation unknown" — requeue them (`UPDATE chunks SET status='ready' WHERE ...`) if occupation-conditioned labels matter retroactively.

`drm-web/` deploy (VM): `cd drm-web && npm ci && npm run build`, run `next start -p 3001` under a `blinks-web` systemd unit (sketch in `drm-web/README.md`); Apache routes `/api`, `/ingest`, `/frames`, `/health` → `127.0.0.1:3000` and everything else → `127.0.0.1:3001`. Server env: `WEB_URL`, `DRM_TZ`, `DRM_AVAILABLE_FROM_HOUR`, `DRM_DEFAULT_BEDTIME`, `DISABLE_PUSH`. Current DRM migrations preserve the round/list data transactionally and remove the obsolete `reconstructions` table only after successful parent/child backfill and validation.

**Local testing aids for the web app:** `drm-web` dev (`npm run dev`, port 3002) **proxies** `/api`, `/frames`, `/health` to the server via `next.config.ts` rewrites (`API_PROXY_TARGET`, default `:3000`) — so dev is same-origin like prod and there is **no CORS setup** (the documented `NEXT_PUBLIC_API_URL` cross-origin path hits CORS and fails at login; the server has no CORS headers by design). `server/scripts/seed-demo-data.ts` seeds two clickable demo participants with one fully labeled field day each — `demo`/`demo12345` and `demo2`/`demo12345` — and both follow the same self-then-assisted flow without a camera/VLM run. Run the server with `DRM_AVAILABLE_FROM_HOUR=0` to test before 19:00. Everyday commands are collected in **`COMMANDS.md`** at the repo root (tracked).

**DRM web developer navigator (2026-07-19):** start both the API server and `drm-web` with `DRM_DEV_MODE=1` (or run `DRM_DEV_MODE=1 ./dev-all.sh`) to show a floating menu linking directly to the self editor, assisted editor, survey page, and offboarding. Dev mode bypasses only the evening gate and the round-1-before-round-2 gate; authentication, participant isolation, autosave/submission, and submitted-round finality remain enforced. Never enable it during the study.

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
- `server/vlm/` — VLM scene-understanding worker (Python; KIT SCC AI toolbox, OpenAI-compatible, Gemma `kit.gemma4-31b-it`). Labels completed 5-minute chunks with multi-image requests. Separate process; runs in parallel with face-blur but waits until attached frames leave pending/processing face status.
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
- **Recording screen:** full-screen, background animates green (`#15803D`) ↔ neutral (`#52525B`) on pause/resume, elapsed **active** (non-paused) time, camera/server/frame/queue status, Pause/Resume + End session. Start/pause/resume/end are persisted as append-only `recording_events` with client and server timestamps plus a session-local sequence number. The app stores an event in a per-participant SecureStore queue before delivery and retries it idempotently, so a temporary network failure does not erase the pause history. Pause still writes the BLE control characteristic and drops in-flight frames. End records the terminal event even when currently paused, clears the server-side pause gate, and closes that session's last filling chunk.
- **History:** sessions list → a compact divided frame list with authenticated thumbnails and capture times, but **no VLM output** (fixed-order anti-leak). Single delete remains available; **Choose Multiple** enters checkbox selection and sends bounded batch deletes. Deletion removes the JPEG, clears its serving path, and retains the frame row with `deleted_at` for audit/counting. Soft-deleted images are excluded from normal live-image reads, exports, face/VLM worker and segmentation input, and direct serving; their rows and timestamps remain visible as tombstones in DRM web frame/photo responses so chronology and activity boundaries stay stable.
- **Capture core (`src/capture/`):** `recording-session-store.ts` is a module-level singleton (survives navigation/backgrounding; notifee FGS keeps JS alive) wiring `CameraLink` (BLE central, reconnect loop) → `FrameAssembler` (tagged reassembly; **stamps capture time at header receipt** — within ~100 ms of true capture since the firmware sends the header right after capture; ESP32 has no clock) → `FrameUploader` (authenticated WS, in-memory queue ≤500 frames, 3 s reconnect, 20 s heartbeat).
- **Build:** needs a dev build (BLE + notifee ≠ Expo Go): `npx expo run:android` or EAS. Dev server override: `EXPO_PUBLIC_SERVER_URL=http://<laptop-ip>:3000 npm start`. `npm run check-all` = tsc + lint (both clean). **First EAS/gradle build not yet run** — notifee 9.1.8 under RN 0.81/new-arch is the thing to watch.

### Server (`server/`) — auth + participant API + phone ingestion, built 2026-06-10

- **Auth:** separate **`server/data/auth.db`** (NOT in `recordings/` — backups/rsyncs of research data must never carry credentials). `users` (username PK = participant id, argon2id `password_hash`, `created_at`) + `auth_tokens` (sha256-hashed opaque 32-byte tokens, no expiry for the short study, revocation = row delete). Login burns comparable argon2 time for unknown users (no username oracle). Provisioning: `npm run create-user -- <username> <password> [--reset]` — no self-signup.
- **Endpoints** (bearer token; each participant sees only their own data): `POST /api/login`, `POST /api/change-password`, `GET /api/sessions` (grouped from `frames`, with live + soft-deleted counts), `GET /api/sessions/:device/:session/frames`, `GET /api/photos` (full pinned-day audit, 403 until round 1 is submitted), single `DELETE /api/sessions/:device/:session/frames/:frameIndex`, batch `DELETE /api/sessions/:device/:session/frames` with `{frameIndexes}` (both idempotent soft-delete paths: JPEG removed, row retained), `GET /frames/<file_path>` (ownership-checked file serving, deliberately not `express.static`), `GET /api/export.csv?device=&session=`, and the event endpoints `POST /api/recording/started`, `/api/pause`, `/api/resume`, `/api/recording/ended`. Every event body contains `eventId`, `session`, `clientEpochMs`, and `sequenceNumber`; replays are idempotent and conflicting ID/sequence reuse returns 409. `GET /health` is open.
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

### VLM scene-understanding worker (`server/vlm/`) — built 2026-06-25, REWORKED to 5-minute chunks 2026-07-19

The context layer is **chunk-based**: ingestion groups frames into clock-aligned 5-minute windows (`chunks`), and the worker labels each completed chunk with one multi-image VLM call (up to `VLM_CHUNK_MAX_FRAMES`=20 evenly sampled frames). It writes the closed activity and category probability distributions plus their deterministic argmax labels onto the chunk; frame API responses can project the corresponding chunk output without duplicating it in `frames`. It does not infer or store scene setting, descriptions, or descriptor vectors. The obsolete per-frame VLM fields and all `user_corrected_*` fields are removed.

- **Chunk lifecycle (server-owned, `server/src/db.ts`):** ingestion attaches each frame to a window and upserts a `filling` chunk. A later-window frame closes earlier chunks to `ready`. The last window closes through `POST /api/recording/ended`, with the `CHUNK_IDLE_CLOSE_MS` sweep as fallback. Soft-deleting a frame decrements its chunk and deletes an empty chunk so labels cannot outlive imagery. Covered by `server/scripts/test-chunks.ts`.

- **Model:** the **KIT SCC AI toolbox**, an **OpenAI-compatible** endpoint (`https://ki-toolbox.scc.kit.edu/api/v1`) — the same service + API key the sibling **KARMA** project uses (`openai` client, `client.chat.completions.create`). Default model **`kit.gemma4-31b-it`** (Gemma is the vision-capable model exposed over the API; the others are text-only). The endpoint is **KIT-hosted**, so even anonymized frames stay inside KIT infrastructure (not a public cloud) — this is what resolved the cloud-VLM data-protection question.
- **Auth:** `KIT_API_KEY` + `KIT_BASE_URL` via env (loaded from a **gitignored `server/vlm/.env`** for local dev, or `EnvironmentFile=` under systemd). The key is reused from KARMA; never commit it.
- **The ordering gate is a column, not a lock.** Workers run independently in parallel; the VLM worker only claims `chunks.status='ready'` when no attached frame is still `face_status` `pending`/`processing`, so it never sees an un-anonymized face. A chunk whose frames all failed blur is marked failed without an API call.
- **Lifecycle:** `chunks.status` `ready → processing → done` (or `failed` after `VLM_MAX_RETRIES`). Startup reclaims leftover `processing` chunks to `ready` under the single-worker assumption.
- **Structured output:** the request supplies a strict JSON schema containing only complete numeric distributions over the exact activity and category key sets. Local validation rejects missing/extra keys, invalid values, and distributions that do not approximately sum to one; the worker normalizes accepted rounding and derives both labels by argmax.
- **Claim ordering (added 2026-07-08):** current-day-first — today's chunks (in `DRM_TZ`, matching the server) are claimed before older backlog; within backlog it is oldest-first.
- **Concurrency (added 2026-07-08):** the endpoint calls are I/O-bound, so the worker runs up to `VLM_CONCURRENCY` (default **8**) in parallel via an in-process thread pool. Only the network calls run in threads; **all DB reads/writes stay on the main thread** (a sqlite3 connection is not thread-shareable), so the claim stays atomic and there are no concurrent-write hazards. The KIT Gemma endpoint was measured (2026-07-08) to parallelize cleanly — flat latency (~2 s) and no 429s up to 8 concurrent, ~2.4 req/s ≈ 8.6k frames/h, ~7× the study's 10-participant-at-30 s load. **Scale via `VLM_CONCURRENCY`, NOT multiple processes** — a 2nd process would double-process (non-atomic claim) and its startup reclaim would stomp the 1st's in-flight rows; multi-process would first need an atomic `... RETURNING` claim + time-based reclaim.
- Setup/run/env/systemd in `server/vlm/README.md`. A failed chunk's anonymized frames stay served but have no label; requeue with `UPDATE chunks SET status='ready' WHERE status='failed'`.

### TLS (open question)

Traffic rides inside the KIT VPN to a KIT-internal server, so the VPN encrypts transport. However, the embedded LimeSurvey makes browser-level TLS important too: BLINKS is currently HTTP while `survey.win.kit.edu` is HTTPS, and LimeSurvey's session/CSRF cookies are not configured `SameSite=None`. Before relying on the embed, terminate TLS at Apache (DNS-01 or a DFN/KIT cert), test a complete submission on the study browser, and keep the new-tab fallback.

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

- **2026-07-30: recording-event audit trail and schema cleanup verified.** Start/pause/resume/end are append-only, idempotent, and durably queued on the phone; ending while paused clears the ingestion gate and closes only that recording session's trailing chunk. The active database migration preserved 8,004 frames, 258 chunks, 6 activity lists, 18 activities, every chunk/activity label and category, and removed the obsolete per-frame VLM plus frame/chunk `user_corrected_*` columns. Server build, focused database/chunk/segmentation/vocabulary tests, full disposable API/WS/DRM smoke test, active app typecheck/lint, SQLite foreign-key check, and `quick_check` pass.
- **2026-07-30: DRM web photo contract restored and regression-tested.** Round-2 and `/api/photos` responses again include stable frame identity and deletion state, preventing undefined React keys and restoring demo2's images. The seeded demo2 day returned 87 frames with no missing identity fields; a live frame URL served JPEG successfully. The disposable full smoke test, server build, web typecheck/build/lint, and focused photo-response assertions pass.
- **2026-07-25: Activity-list-owned round workflow simplified.** `activity_lists` owns both list identity and round workflow; no `reconstructions` table remains and redundant `mode` is removed. Transactional migration preserves legacy reconstruction status/timing, stable parent/child IDs, the immutable proposal, and empty opened rounds, while converting the retired round-2 self response role to `kind=assisted`. Database constraints enforce round 1 `self` and round 2 `vlm_proposal|assisted`.
- **2026-07-19: 5-minute-chunk rework verified end-to-end.** Server build; chunk lifecycle/delete tests; 12-case chunk segmentation tests; full smoke test over pending semantics, chunk segmentation, and `/api/recording/ended`; live multi-image KIT VLM check.
- **2026-06-10: server smoke test passing end-to-end** (see server section above). `server` builds clean (`tsc`); `blinks-edge-app` passes `tsc --noEmit` + `expo lint`.
- **2026-06-24: face-blur worker verified.** CenterFace detect + mosaic + atomic in-place overwrite confirmed on a real captured frame (1 face detected at 0.47, pixelated; ~30 ms/frame on CPU). The additive DB migration adds the `face_*` columns to the existing `recordings.db` (all pre-existing rows default to `pending` for backfill). `server` still builds clean (`tsc`); the smoke test now also covers the serving gate.
- **2026-06-25: historical VLM worker verification.** The earlier worker version processed an anonymized frame against the live KIT SCC AI toolbox and the `face_status='pending'` safety gate held. That historical response included a descriptor; descriptor inference and both descriptor columns were subsequently retired. The current closed-enum response schema still requires a fresh live endpoint check before deployment.
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
- **VLM scene-understanding worker** (`server/vlm/`, 2026-06-25; chunk rework 2026-07-19): KIT SCC AI toolbox (Gemma `kit.gemma4-31b-it`, OpenAI-compatible) writes activity and category probability distributions plus their argmax labels per completed 5-minute chunk after face processing. See the VLM worker section above.

### Next

- **DRM Subproject — remaining before the study:** verify LimeSurvey Panel Integration maps `participantId` to the hidden participant-ID question and test a complete embedded submission plus the new-tab fallback on the study browser; pilot-test the shared 17-label taxonomy and dropdown comprehension, then freeze the matching server/web/VLM definitions (`server/src/activity-vocabulary.ts`, `drm-web/src/lib/activity-vocabulary.ts`, and `server/vlm/vlm_worker.py`); run a live structured-output VLM check; make a fresh app dev build; deploy the current migrations.
- **BLE frame-loss fix** (see the fix ladder in the firmware area): ~45% of frames are dropped camera→phone while the app is backgrounded; firmware flow control on `notify()` is the main candidate.
- **VM migration + first real deploy** of the restructured repo (steps above), incl. Apache `/ingest` upgrade rule, web-app routing, and participant account provisioning.
- **TLS decision** (VPN-only vs. Apache TLS with DNS-01/DFN cert) for the data-protection documentation.
- Optional hardening: disk-backed upload queue in the app (currently in-memory, bounded at 500 frames), pagination for `/api/sessions/...` (a full session day at 30 s spacing is ~2.9 k frames — fine unpaginated for v1).
- **Deferred to the full version (post-DRM):** design the EMA/CPD representation and adaptive-push logic separately; overnight-relay re-test at the study interval.

### Storage and VLM metadata (implemented 2026-06-06; chunk rework 2026-07-19)

- **Frames stay on the filesystem** under `server/recordings/...`. Rationale: the VLM stage reads sequentially, every image tool speaks "JPEG on disk", `rsync` backups are incremental, and GDPR erasure for a participant is a directory delete rather than a `DELETE` + `VACUUM`.
- **Metadata and VLM output go in SQLite** (`server/recordings/recordings.db`, WAL mode). Ingestion inserts the frame and maintains its clock-aligned 5-minute `chunks` row in the same transaction. VLM output lives only on `chunks`; frames retain only capture/file/face-processing metadata.

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
  file_path         TEXT    NOT NULL,            -- cleared to '' after file deletion
  -- QA (cheap, catches dropped / corrupt frames)
  device_frame      INTEGER,                     -- camera's own counter (BLE header); gaps = captured but undelivered
  byte_length       INTEGER,
  jpeg_ok           INTEGER,                     -- 0/1 from the SOI/EOI check
  chunk_start_ms    INTEGER,                     -- clock-aligned 5-minute window
  -- Face anonymization, filled by the face-blur worker BEFORE the frame is served
  face_status       TEXT    NOT NULL DEFAULT 'pending',  -- pending|processing|done|failed
  face_count        INTEGER,                        -- faces detected/obscured
  face_method       TEXT,                           -- e.g. 'mosaic:centerface@0.2'
  face_completed_at INTEGER,
  deleted_at        INTEGER,                        -- NULL=live; epoch ms=soft-deleted
  PRIMARY KEY (participant, device, session, frame_index)
);
CREATE INDEX idx_frames_time         ON frames (participant, capture_epoch_ms);
CREATE INDEX idx_frames_face_pending ON frames (capture_epoch_ms) WHERE face_status = 'pending' AND deleted_at IS NULL;

CREATE TABLE chunks (
  participant     TEXT NOT NULL,
  chunk_start_ms  INTEGER NOT NULL,
  chunk_end_ms    INTEGER NOT NULL,
  frame_count     INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'filling',
  vlm_model       TEXT,
  vlm_label       TEXT,
  vlm_category    TEXT,
  PRIMARY KEY (participant, chunk_start_ms)
);

CREATE TABLE recording_events (
  participant             TEXT NOT NULL,
  event_id                TEXT NOT NULL,
  session                 INTEGER NOT NULL,
  event_type              TEXT NOT NULL CHECK (event_type IN ('start','pause','resume','end')),
  client_epoch_ms         INTEGER NOT NULL,
  server_received_epoch_ms INTEGER NOT NULL,
  sequence_number         INTEGER NOT NULL,
  PRIMARY KEY (participant, event_id),
  UNIQUE (participant, session, sequence_number)
);
```

- **Chunk-level VLM output is inline for v1.** If multi-pass comparison is needed later, split it into results keyed by `(participant, chunk_start_ms, model)`.
- **DRM list identity and round workflow are explicit.** `activity_lists.id` is the stable parent key. The response parent stores participant, round, pinned day, `kind`, status, and round timings; the immutable `vlm_proposal` parent stores proposal exposure. `activities.activity_list_id` is the enforced child foreign key. The invariant mapping is round 1 → `self`, round 2 → `vlm_proposal` + `assisted`; there is no separate `mode` truth to synchronize.
- The app's read path (sessions/frames/images, all authenticated + participant-scoped) is implemented; a time-range `/api/timeline?from=&to=` endpoint (cursor-paginated) can be added for the admin panel when the VLM service lands.
- **Recording pause state is derived from `recording_events`.** At startup the server restores the current pause gate from each participant's latest event; `paused.json` is no longer read or written. The append-only rows support pause counts, intervals, incomplete-pause detection, client/server clock comparison, and session attribution.
- **Credentials live in `server/data/auth.db`**, deliberately outside the recordings tree (see server section).

### VLM inference and biosignal alignment

- **VLM worker BUILT + verified 2026-06-25, chunk-based since 2026-07-19 (`server/vlm/`).** Reads face-processed frames from a ready chunk, sends a bounded multi-image sample, and writes the result to that chunk. It remains asynchronous, so inference latency or crashes never cost captured frames.
- Alignment with biosignals (Cardioban EKG, Mendi fNIRS, planned camera-glasses frame) uses `capture_epoch_ms`. In the relay architecture this is the **phone's clock at BLE header receipt** (≤ ~100 ms after true capture at 30 s spacing — sufficient for session-level alignment; the phone is NTP-synced by Android). The Mendi raw-optical-channel question and the larger longitudinal study (questionnaires, GDPR documentation) are tracked separately.
- An internal **admin panel** to review frames + labels in time order is the read path plus a small static page. No separate backend needed.

### Adaptive EMA notifications (design decision, not yet implemented)

- **If change point detection is added, it lives in the backend, not the app.** Its input representation is intentionally undecided; the current DRM worker stores only activity and category probability distributions plus their argmax labels. Once that representation is designed, CPD can run over the recent window and decide whether a sustained activity change occurred. It is never done client-side. Reasons:
  - A push that reaches a backgrounded or closed app must originate server-side (server to FCM to phone). The app is closed exactly when a prompt matters, so in-app polling cannot deliver it. Android Doze / App Standby and OEM background-killers make in-app background polling unreliable, while a high-priority FCM message punches through Doze.
  - Detection is part of the scientific method, so it belongs in one versioned backend implementation, reproducible and identical to offline analysis, not reimplemented in app JS over whatever happened to be in a poll window.
  - Gating (rate-limit, quiet hours, minimum inter-prompt interval, respecting a participant's paused state) is centralized server-side.
- **Delivery path:** the app obtains an Expo push token and registers it with the server (e.g. `POST /api/register-push`, authenticated, persisted per participant). On a detected sustained change the server sends a high-priority push via the Expo push service (which fronts FCM). Tapping the notification opens the app to the EMA prompt / timeline.
- **Possible future EMA trigger flow:** the backend writes the selected CPD representation, runs CPD over the recent window, and on a sustained change (when not paused, rate-limited, or in quiet hours) sends a high-priority push. This is not part of the current DRM implementation.

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
curl -X POST http://localhost:3000/api/recording/started -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"eventId":"1710000000-0","session":1710000000,"clientEpochMs":1710000000000,"sequenceNumber":0}'
curl -X POST http://localhost:3000/api/pause -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"eventId":"1710000000-1","session":1710000000,"clientEpochMs":1710000010000,"sequenceNumber":1}'
curl -X POST http://localhost:3000/api/resume -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"eventId":"1710000000-2","session":1710000000,"clientEpochMs":1710000020000,"sequenceNumber":2}'
curl -X POST http://localhost:3000/api/recording/ended -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"eventId":"1710000000-3","session":1710000000,"clientEpochMs":1710000030000,"sequenceNumber":3}'
curl "http://localhost:3000/api/export.csv?device=<id>&session=<epoch>" -H "Authorization: Bearer $TOKEN"
```

Find the laptop IP for `EXPO_PUBLIC_SERVER_URL` during LAN development:

```bash
ipconfig getifaddr en0
```

Serial Monitor baud rate: **115200**. Firmware capture interval: `CAPTURE_INTERVAL_MS` in `camera-firmware/camera-firmware.ino` (5 s bring-up / 30 s study).
