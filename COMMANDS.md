# BLINKS — command reference

Everyday commands for running and testing the stack locally. Paths are relative
to the repo root (`esp32s3-vlm-inference/`). For the *why* behind any of this,
see `CLAUDE.md`.

## Node version (important)

A non-interactive shell can resolve an old Node (v15) and break `tsx` /
`better-sqlite3`. Pin the right version per component:

```bash
export PATH="$HOME/.nvm/versions/node/v20.18.0/bin:$PATH"   # server (Node 20)
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"   # app + drm-web (Node 22)
```

---

## 1. Server (`server/`, port 3000)

```bash
cd server
npm install                 # once
npm run dev                 # tsx watch, http://localhost:3000  (dev)
npm run build && npm start   # compiled dist/server.js          (prod)
```

Env knobs (all optional; prepend to the command, e.g. `DISABLE_PUSH=1 npm run dev`):

| Var | Default | Meaning |
|---|---|---|
| `CAMERA_PORT` | `3000` | HTTP + WS port |
| `RECORDINGS_DIR` | `server/recordings` | frames + `recordings.db` |
| `DATA_DIR` | `server/data` | `auth.db` (credentials, kept out of recordings) |
| `AUTH_DB_PATH` | `<DATA_DIR>/auth.db` | override the auth DB path |
| `WEB_URL` | `http://blinks.win.kit.edu` | DRM website URL put into push notifications |
| `DRM_TZ` | `Europe/Berlin` | study timezone for day keys + the gate |
| `DRM_AVAILABLE_FROM_HOUR` | `19` | hour today's reconstruction opens; **set `0` for testing** |
| `DRM_DEFAULT_BEDTIME` | `22:00` | fallback-push bedtime for participants without a stored one |
| `DRM_DEV_MODE` | (off) | `1` enables direct DRM dev pages and bypasses the evening + round-order gates; never enable for the study |
| `DISABLE_PUSH` | (off) | `1` turns the push scheduler off (use in dev/tests) |

The push is a single **bedtime fallback**: at the participant's reported
bedtime (app onboarding) minus 10 min, if they captured frames today and round
2 is not submitted yet. Bedtimes before noon (after-midnight sleepers) clamp
the reminder to 23:50.

Typical dev run (gate open, no push spam):

```bash
DRM_AVAILABLE_FROM_HOUR=0 DISABLE_PUSH=1 npm run dev
```

### Create / manage participants

```bash
# every participant: round 1 self, round 2 VLM-assisted
npm run create-user -- participant1 <password>

# reset a password (keeps occupation/schedule):
npm run create-user -- participant1 <newpassword> --reset
```

- Username: letters/digits/`-`/`_` only (it becomes the recordings folder name).
- Password: ≥ 8 chars.
- Writes the auth user (`auth.db`) **and** a `participants` row (`recordings.db`).
  Run it with the **same `RECORDINGS_DIR`/`DATA_DIR`** the server uses, or it
  writes to a different DB. Occupation + wake/bed times are entered by the
  participant in the app.

### Tests

```bash
npx tsx scripts/test-segmentation.ts    # chunk segmentation + mean-probability tests (10 cases)
npx tsx scripts/test-incorrect-annotation-injection.ts  # 10%, 0.8 threshold, fallback, alternatives
npx tsx scripts/test-activity-vocabulary.ts  # VLM/API/dropdown enum stays identical
npx tsx scripts/test-activity-lists.ts  # legacy/natural-key migration + parent FK + three-list immutability
npx tsx scripts/test-recording-events.ts  # idempotent lifecycle events + pause restoration + session-specific close
npx tsx scripts/test-reconstruction-timing-migration.ts  # reconstructions -> response-parent workflow/timing migration

# inspect/backfill probability columns on legacy demo rows only (also maps
# old democtl free-text fixture labels to the current closed enum):
npm run backfill-demo-probabilities
npm run backfill-demo-probabilities -- --apply
# Rewrite existing seed vectors too (fixture data only):
npm run backfill-demo-probabilities -- --apply --force

# end-to-end smoke test (needs its own throwaway dirs + a matching server):
rm -rf /tmp/blinks-smoke && mkdir -p /tmp/blinks-smoke/{recordings,data}
DATA_DIR=/tmp/blinks-smoke/data RECORDINGS_DIR=/tmp/blinks-smoke/recordings \
  npx tsx scripts/create-user.ts smoketester password123
DATA_DIR=/tmp/blinks-smoke/data RECORDINGS_DIR=/tmp/blinks-smoke/recordings \
  npx tsx scripts/create-user.ts smokesecond password123
RECORDINGS_DIR=/tmp/blinks-smoke/recordings DATA_DIR=/tmp/blinks-smoke/data \
  CAMERA_PORT=3100 DRM_AVAILABLE_FROM_HOUR=0 DISABLE_PUSH=1 node dist/server.js &   # (npm run build first)
SMOKE_BASE_URL=http://127.0.0.1:3100 RECORDINGS_DIR=/tmp/blinks-smoke/recordings \
  npx tsx scripts/smoke-test.ts
```

### Inspect recording pauses

The raw start/pause/resume/end observations are append-only. This query shows
the exact event stream for one participant:

```bash
sqlite3 recordings/recordings.db "
  SELECT session, sequence_number, event_type,
         datetime(client_epoch_ms / 1000, 'unixepoch', 'localtime') AS client_time,
         datetime(server_received_epoch_ms / 1000, 'unixepoch', 'localtime') AS received_time
  FROM recording_events
  WHERE participant = 'participant1'
  ORDER BY session, sequence_number;
"
```

This derives each completed recording-pause interval by pairing a `pause` with
the immediately following `resume` or `end`. A pause with no following event
remains visible as incomplete instead of silently inventing an end time.

```bash
sqlite3 recordings/recordings.db "
  WITH ordered AS (
    SELECT participant, session, sequence_number, event_type, client_epoch_ms,
           LEAD(event_type) OVER (
             PARTITION BY participant, session ORDER BY sequence_number
           ) AS next_type,
           LEAD(client_epoch_ms) OVER (
             PARTITION BY participant, session ORDER BY sequence_number
           ) AS next_client_epoch_ms
    FROM recording_events
    WHERE participant = 'participant1'
  )
  SELECT session,
         datetime(client_epoch_ms / 1000, 'unixepoch', 'localtime') AS pause_start,
         CASE WHEN next_type IN ('resume', 'end')
              THEN datetime(next_client_epoch_ms / 1000, 'unixepoch', 'localtime')
         END AS pause_end,
         CASE WHEN next_type IN ('resume', 'end')
              THEN (next_client_epoch_ms - client_epoch_ms) / 1000.0
         END AS duration_seconds
  FROM ordered
  WHERE event_type = 'pause'
  ORDER BY session, sequence_number;
"
```

---

## 2. Face-blur worker (`server/face-blur/`, Python) — required before VLM

Separate process; the server does **not** start it. Frames stay hidden until it
marks them anonymized.

```bash
cd server/face-blur
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   # once
.venv/bin/python blur_worker.py            # daemon: poll + anonymize forever
.venv/bin/python blur_worker.py --once     # process the current backlog, then exit
```

Env: `FACE_THRESHOLD` (default `0.2`, lower = safer), `FACE_METHOD=mosaic|blur`,
`POLL_INTERVAL_S` (default `2.0`), `RECORDINGS_DIR`.

---

## 3. VLM worker (`server/vlm/`, Python) — makes assisted days appear

Labels **5-minute chunks** (one multi-image call per chunk; frames inherit the
chunk's label). A chunk becomes inferable once the server closed its window
(`chunks.status='ready'`) AND every frame in it is through the face-blur
worker. An assisted day stays "still being processed" in the web app until all
its chunks are done — the server's idle sweep closes the day's last window
~10 min after the final frame arrives (`CHUNK_IDLE_CLOSE_MS`).

```bash
cd server/vlm
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   # once
cp .env.example .env        # then put the real KIT_API_KEY in .env (gitignored)
.venv/bin/python vlm_worker.py             # daemon: poll + label forever
.venv/bin/python vlm_worker.py --once      # process the backlog, then exit
.venv/bin/python vlm_worker.py --once --max 5   # just a few chunks (testing)
```

Needs `KIT_API_KEY` in `.env` and the **KIT network / VPN** (endpoint is
KIT-internal). Env: `VLM_MODEL` (default `kit.gemma4-31b-it`),
`VLM_CHUNK_MAX_FRAMES` (`20`, evenly sampled per chunk), `VLM_MAX_RETRIES`
(default `3`, then the chunk is marked `failed`), `BATCH_SIZE` (`8` chunks per
poll), `POLL_INTERVAL_S` (`3.0`).

Requeue failed chunks after fixing the cause:

```bash
sqlite3 recordings/recordings.db "UPDATE chunks SET status='ready' WHERE status='failed'"
```

---

## 4. DRM web app (`drm-web/`, dev port 3002 / prod port 3001)

```bash
cd drm-web
npm install                 # once
npm run dev                 # http://localhost:3002 (Node 22)
npm run build && npm start   # production build on port 3001
```

To show the floating dev navigator and open either reconstruction round
directly, start both the server and web app with `DRM_DEV_MODE=1`. The pages
use the signed-in account's real data and keep normal autosave/submission
behavior. Authentication and submitted-round finality still apply.

- Dev proxies `/api`, `/frames`, `/health` to the server, so **no CORS setup**.
  Default target is `http://127.0.0.1:3000`; override with
  `API_PROXY_TARGET=http://127.0.0.1:3100 npm run dev`.
- Login uses the same participant credentials as the app.

### Seed clickable demo data (no camera/VLM run needed)

```bash
cd server
RECORDINGS_DIR=<same as server> DATA_DIR=<same as server> \
  npx tsx scripts/seed-demo-data.ts        # demo + demo2, password demo12345
```

Creates two participants, each with one fully labeled field day (today).
`demo` and `demo2` both follow step 1 self, step 2 VLM-assisted, so the
invariant two-round flow is clickable immediately.
Re-runnable (resets the demo users).

---

## 5. Mobile app (`blinks-edge-app/`)

```bash
cd blinks-edge-app
npm install                 # once
npm run check-all           # tsc + expo lint

# build a dev client onto the phone (needed: BLE + notifee ≠ Expo Go):
npx expo run:android                                   # local (Android SDK on this machine)
npx eas build --profile development --platform android  # cloud build (APK)

# then run Metro so the dev client can load JS:
npm start                   # LAN — phone must be on the same WiFi
npm run start-tunnel        # tunnel via ngrok — when phone is on a different network
```

**Pointing the app at a server** — edit `blinks-edge-app/.env.local` (gitignored),
then restart Metro with `--clear`:

```
EXPO_PUBLIC_SERVER_URL=http://192.168.0.x:3000              # laptop LAN IP (same WiFi)
EXPO_PUBLIC_SERVER_URL=https://<name>.ngrok-free.dev        # ngrok-tunneled server (any network)
# (unset) -> falls back to http://blinks.win.kit.edu (needs KIT VPN)
```

- The login screen (dev builds) shows the configured server URL at the bottom.
- `EXPO_PUBLIC_*` is inlined at bundle time → after editing `.env.local`, run
  `npx expo start --dev-client --clear` and reload the app.
- Find your LAN IP: `ipconfig getifaddr en0`.

---

## Quick "everything up for a full local test"

From the repo root, start the server, its `ngrok http 3000` tunnel, both Python
workers, DRM web app, and Metro together:

```bash
./dev-all.sh
DRM_DEV_MODE=1 ./dev-all.sh   # floating DRM dev navigator + direct round access
```

The output uses a different color/name prefix for each background service.
Metro remains attached directly to the terminal, so its QR code and keyboard
shortcuts still work. The launcher first requests Expo's dev-client tunnel. If
that shared tunnel service is unavailable, it keeps the other services running
and restarts Metro in LAN mode; connect the phone to the same WiFi and scan the
replacement QR code. `Ctrl+C` stops the whole stack. The launcher defaults to
`DRM_AVAILABLE_FROM_HOUR=0` and `DISABLE_PUSH=1`; either can still be overridden:

```bash
DRM_AVAILABLE_FROM_HOUR=19 DISABLE_PUSH=0 ./dev-all.sh
./dev-all.sh --check       # verify Node, dependencies, venvs, ngrok, and ports
```

It uses the repo's documented Node 20 path for the server and Node 22 path for
the web/mobile apps. Override these when needed with `SERVER_NODE_BIN` and
`APP_NODE_BIN` (each points to a directory containing `node` and `npm`).

Manual fallback (six terminals):

```bash
# 1) server (gate open, push off)
cd server && DRM_AVAILABLE_FROM_HOUR=0 DISABLE_PUSH=1 npm run dev

# 2) public backend tunnel
ngrok http 3000

# 3) face-blur worker
cd server/face-blur && .venv/bin/python blur_worker.py

# 4) VLM worker (KIT VPN + KIT_API_KEY in .env)
cd server/vlm && .venv/bin/python vlm_worker.py

# 5) web app
cd drm-web && npm run dev        # http://localhost:3002

# 6) Metro + tunnel (keeps the QR code visible)
cd blinks-edge-app && npm run start-tunnel
```

Then `npm run create-user -- <user> <pw>`, record from the
phone (or `npx tsx scripts/seed-demo-data.ts` for instant demo data), and open
the web app in the evening (or with `DRM_AVAILABLE_FROM_HOUR=0`, any time).

## Handy DB peeks (`server/recordings/recordings.db`)

```bash
# chunk status for a participant (why the assisted round is/ isn't ready):
sqlite3 recordings/recordings.db \
  "SELECT status, COUNT(*) FROM chunks WHERE participant='<user>' GROUP BY status"

# the labeled 5-minute timeline and both argmax probabilities:
sqlite3 recordings/recordings.db \
  "SELECT datetime(chunk_start_ms/1000,'unixepoch','localtime'), vlm_label, vlm_category, \
          vlm_activity_confidence, vlm_category_confidence \
   FROM chunks WHERE participant='<user>' ORDER BY chunk_start_ms"

# participant profiles (the legacy arm column may still exist but is ignored):
sqlite3 recordings/recordings.db \
  "SELECT username, occupation, wake_time, bed_time FROM participants"

# activity lists + round workflow (kind is the sole role discriminator):
sqlite3 recordings/recordings.db \
  "SELECT id, participant, round, kind, day, status, submitted_at, proposal_viewed_at \
   FROM activity_lists ORDER BY participant, round, kind"

# genuine, presented, and final assisted annotations for intervention analysis:
sqlite3 recordings/recordings.db \
  "SELECT l.kind, a.position, a.raw_label, a.category_label, \
          a.vlm_raw_label, a.vlm_category, a.presented_raw_label, \
          a.presented_category_label, a.vlm_mean_activity_confidence, \
          a.vlm_mean_category_confidence, \
          a.is_incorrect_annotation_injected \
   FROM activities a JOIN activity_lists l ON l.id=a.activity_list_id \
   WHERE l.participant='<user>' AND l.round=2 ORDER BY l.kind, a.position"

# unlock a submitted round for a participant (researcher-only escape hatch):
sqlite3 recordings/recordings.db \
  "UPDATE activity_lists SET status='draft', submitted_at=NULL \
   WHERE participant='<user>' AND round=2 AND kind!='vlm_proposal'"
```
