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
# main arm (default): round 2 = VLM-assisted
npm run create-user -- participant1 <password>

# control arm: round 2 = self again (pure repetition baseline)
npm run create-user -- participant7 <password> --arm control

# reset a password (keeps occupation/schedule + arm unless --arm is also given):
npm run create-user -- participant1 <newpassword> --reset

# reset a password AND change the arm:
npm run create-user -- participant1 <newpassword> --reset --arm control
```

- `--arm` = `main` (round 2 assisted) or `control` (round 2 self again);
  round 1 is always self. The arm can be changed until the participant first
  opens round 2 (its mode is pinned then).
- Username: letters/digits/`-`/`_` only (it becomes the recordings folder name).
- Password: ≥ 8 chars.
- Writes the auth user (`auth.db`) **and** a `participants` row (`recordings.db`).
  Run it with the **same `RECORDINGS_DIR`/`DATA_DIR`** the server uses, or it
  writes to a different DB. Occupation + wake/bed times are entered by the
  participant in the app.

### Tests

```bash
npx tsx scripts/test-segmentation.ts    # pure segmentation unit tests (10 cases)

# end-to-end smoke test (needs its own throwaway dirs + a matching server;
# one user per study arm):
rm -rf /tmp/blinks-smoke && mkdir -p /tmp/blinks-smoke/{recordings,data}
DATA_DIR=/tmp/blinks-smoke/data RECORDINGS_DIR=/tmp/blinks-smoke/recordings \
  npx tsx scripts/create-user.ts smoketester password123
DATA_DIR=/tmp/blinks-smoke/data RECORDINGS_DIR=/tmp/blinks-smoke/recordings \
  npx tsx scripts/create-user.ts smokecontrol password123 --arm control
RECORDINGS_DIR=/tmp/blinks-smoke/recordings DATA_DIR=/tmp/blinks-smoke/data \
  CAMERA_PORT=3100 DRM_AVAILABLE_FROM_HOUR=0 DISABLE_PUSH=1 node dist/server.js &   # (npm run build first)
SMOKE_BASE_URL=http://127.0.0.1:3100 RECORDINGS_DIR=/tmp/blinks-smoke/recordings \
  npx tsx scripts/smoke-test.ts
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

Processes only frames the face-blur worker has marked `done`. An assisted day
stays "still being processed" in the web app until **all** its frames are VLM-done.

```bash
cd server/vlm
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   # once
cp .env.example .env        # then put the real KIT_API_KEY in .env (gitignored)
.venv/bin/python vlm_worker.py             # daemon: poll + label forever
.venv/bin/python vlm_worker.py --once      # process the backlog, then exit
.venv/bin/python vlm_worker.py --once --max-frames 20   # just a few (testing)
```

Needs `KIT_API_KEY` in `.env` and the **KIT network / VPN** (endpoint is
KIT-internal). Env: `VLM_MODEL` (default `kit.gemma4-31b-it`), `VLM_MAX_RETRIES`
(default `3` = 1 try + 2 retries, then the frame is marked `failed`),
`BATCH_SIZE` (`20`), `POLL_INTERVAL_S` (`3.0`).

Requeue failed frames after fixing the cause:

```bash
sqlite3 recordings/recordings.db "UPDATE frames SET vlm_status='pending' WHERE vlm_status='failed'"
```

---

## 4. DRM web app (`drm-web/`, dev port 3002 / prod port 3001)

```bash
cd drm-web
npm install                 # once
npm run dev                 # http://localhost:3002 (Node 22)
npm run build && npm start   # production build on port 3001
```

- Dev proxies `/api`, `/frames`, `/health` to the server, so **no CORS setup**.
  Default target is `http://127.0.0.1:3000`; override with
  `API_PROXY_TARGET=http://127.0.0.1:3100 npm run dev`.
- Login uses the same participant credentials as the app.

### Seed clickable demo data (no camera/VLM run needed)

```bash
cd server
RECORDINGS_DIR=<same as server> DATA_DIR=<same as server> \
  npx tsx scripts/seed-demo-data.ts        # demo + democtl, password demo12345
```

Creates two participants, each with one fully labeled field day (today):
`demo` = main arm (step 2 VLM-assisted), `democtl` = control arm (step 2 self
again), so the whole two-round flow is clickable for both arms immediately.
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

Four terminals:

```bash
# 1) server (gate open, push off)
cd server && DRM_AVAILABLE_FROM_HOUR=0 DISABLE_PUSH=1 npm run dev

# 2) face-blur worker
cd server/face-blur && .venv/bin/python blur_worker.py

# 3) VLM worker (KIT VPN + KIT_API_KEY in .env)
cd server/vlm && .venv/bin/python vlm_worker.py

# 4) web app
cd drm-web && npm run dev        # http://localhost:3002
```

Then `npm run create-user -- <user> <pw> [--arm control]`, record from the
phone (or `npx tsx scripts/seed-demo-data.ts` for instant demo data), and open
the web app in the evening (or with `DRM_AVAILABLE_FROM_HOUR=0`, any time).

## Handy DB peeks (`server/recordings/recordings.db`)

```bash
# frame status for a participant (why the assisted round is/ isn't ready):
sqlite3 recordings/recordings.db \
  "SELECT vlm_status, COUNT(*) FROM frames WHERE participant='<user>' GROUP BY vlm_status"

# a participant's arm + profile:
sqlite3 recordings/recordings.db \
  "SELECT username, arm, occupation, wake_time, bed_time FROM participants"

# reconstruction rounds (mode is pinned when the round is first opened):
sqlite3 recordings/recordings.db \
  "SELECT participant, round, mode, day, status, submitted_at FROM reconstructions"

# unlock a submitted round for a participant (researcher-only escape hatch):
sqlite3 recordings/recordings.db \
  "UPDATE reconstructions SET status='draft', submitted_at=NULL WHERE participant='<user>' AND round=2"
```
