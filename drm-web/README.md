# drm-web — BLINKS Day Reconstruction web app

Participant-facing web app for the DRM subproject (single-day, two-round
design). On the first login in the lab, the participant must replace the
lab-issued password and open the pre-study LimeSurvey questionnaire. In the
evening of their field day they reconstruct that day in **two sequential
rounds, fixed order** — step 1 is always Self DRM (from memory, no frames, no
VLM output), step 2 unlocks only after step 1 is submitted and is always
VLM-assisted (frames + editable auto-segmented activity list). The final
questionnaire opens in a new tab, followed by offboarding. Onboarding and the
frames/VLM anti-leak are enforced server-side.

Stack: Next.js (App Router, TypeScript strict, `src/` dir, Tailwind v4) +
shadcn/ui + TanStack Query. The app is a pure client of the BLINKS server API
(`../server`); it has no database or server-side state of its own.

## Pages (a linear pipeline)

| Route             | Purpose                                                               |
| ----------------- | --------------------------------------------------------------------- |
| `/`               | Landing + participant login (same credentials as the phone app)       |
| `/onboarding`     | First-run password change + external pre-study LimeSurvey link        |
| `/reconstruct`    | The two-step flow: step progress header + the active round's editor   |
| `/survey`         | External final LimeSurvey link with participant-specific URL          |
| `/done`           | Offboarding: thank-you, device-return hint, sign-out                  |
| `/dev/onboarding` | Non-mutating, fully interactive onboarding preview (`DRM_DEV_MODE=1`) |

Next's proxy performs an optimistic cookie-based route redirect. The API is the
security boundary: reconstruction reads and writes return
`onboarding_required` until both first-run steps have been persisted, in
addition to enforcing authentication, round order, and the evening gate.

## Auth model

- `POST /api/login` returns a bearer token; it is stored in `localStorage` and
  sent as an `Authorization` header on every JSON request.
- The token is **also** mirrored into a `blinks_token` cookie (`path=/`)
  because `<img>` tags cannot send headers — the server accepts the cookie for
  `GET /frames/*` (images) **only**. JSON APIs stay header-only (CSRF hygiene).
- Any 401 clears the token and redirects to `/`.
- Login also returns the persisted onboarding state. A non-sensitive
  `blinks_onboarding` cookie is used only for route routing; the server checks
  the database before protected reconstruction API access.
- `POST /api/onboarding/password` uses the authenticated login token and asks
  only for the new password. The normal `/api/change-password` endpoint keeps
  its current-password check for changes outside first-run onboarding.
- Sign-out and sign-in both call `queryClient.clear()`: no cached rounds or
  frame URLs may survive into another account's session on a shared browser
  (anti-leak), and a submitted round is never mounted in the editable editor.

## Development

```bash
npm install
npm run dev   # http://localhost:3002 (BLINKS API expected on :3000)
```

- Dev server runs on port **3002** (3000 is the BLINKS API, 3001 is this app's
  production port, and Expo/Metro of the phone app tends to sit on 8081+).
- **No CORS setup needed:** in dev, Next proxies `/api/*`, `/frames/*`, and
  `/health` to the Express server (rewrites in `next.config.ts`), so the app
  is same-origin in dev exactly like in production (where Apache does the
  routing). Point the proxy elsewhere with `API_PROXY_TARGET`, e.g.
  `API_PROXY_TARGET=http://127.0.0.1:3100 npm run dev`.
- For clickable local test data (`demo` and `demo2`, each with one fully
  labeled field day and the same self-then-assisted workflow), see
  `server/scripts/seed-demo-data.ts`.

Env vars:

| Variable                            | Default                 | Meaning                                                  |
| ----------------------------------- | ----------------------- | -------------------------------------------------------- |
| `API_PROXY_TARGET`                  | `http://127.0.0.1:3000` | Dev-proxy target for `/api`, `/frames`, `/health`        |
| `DRM_DEV_MODE`                      | (off)                   | `1` shows direct dev navigation; set on API server too   |
| `NEXT_PUBLIC_API_URL`               | `""` (same origin)      | API base override; normally never needed                 |
| `NEXT_PUBLIC_DRM_TZ`                | `Europe/Berlin`         | Study timezone; keep in sync with the server's `DRM_TZ`  |
| `NEXT_PUBLIC_ONBOARDING_SURVEY_URL` | (required)              | Pre-study LimeSurvey base URL; app adds `participant_id` |
| `NEXT_PUBLIC_FINAL_SURVEY_URL`      | (required)              | Final LimeSurvey base URL; app adds `participantId`      |

Copy `.env.example` to `.env.local` for development. `NEXT_PUBLIC_*` values
are compiled into the client bundle, so production values must be present when
running `npm run build`.

With `DRM_DEV_MODE=1` on both the web app and API server, a floating menu
links directly to the onboarding preview, Self DRM, VLM-assisted DRM, the
survey page, and offboarding. `/dev/onboarding` is fully clickable but never
changes the signed-in account, password, or persisted onboarding state.
The reconstruction pages use the signed-in development account's real round
data and keep autosave/submission enabled. The API bypasses only the evening
and round-order gates; auth, participant isolation, and submitted-round
finality remain enforced. Never enable this flag during the study.

## Build + run (production)

```bash
npm ci
npm run build          # standalone output (.next/standalone)
npm start              # next start -p 3001
```

`next.config.ts` uses `output: "standalone"`, so the build can also be run
without `node_modules` via the bundled server:

```bash
cp -r public .next/standalone/
cp -r .next/static .next/standalone/.next/
PORT=3001 node .next/standalone/server.js
```

## Deployment on the KIT VM (blinks.win.kit.edu)

Apache fronts both processes on port 80: the Node API (`blinks`, `:3000`)
keeps `/api`, `/ingest`, `/frames`, `/health`; everything else goes to this
app (`blinks-web`, `:3001`). Snippet for the `blinks.conf` vhost:

```apache
<VirtualHost *:80>
    ServerName blinks.win.kit.edu

    ProxyPreserveHost On

    # WebSocket ingestion (phone app)
    ProxyPass        /ingest ws://127.0.0.1:3000/ingest
    ProxyPassReverse /ingest ws://127.0.0.1:3000/ingest

    # API + images + health stay on the Node server
    ProxyPass        /api    http://127.0.0.1:3000/api
    ProxyPassReverse /api    http://127.0.0.1:3000/api
    ProxyPass        /frames http://127.0.0.1:3000/frames
    ProxyPassReverse /frames http://127.0.0.1:3000/frames
    ProxyPass        /health http://127.0.0.1:3000/health
    ProxyPassReverse /health http://127.0.0.1:3000/health

    # Everything else -> drm-web (Next.js)
    ProxyPass        / http://127.0.0.1:3001/
    ProxyPassReverse / http://127.0.0.1:3001/
</VirtualHost>
```

(`proxy`, `proxy_http`, and `proxy_wstunnel` are already enabled on the VM.
Order matters: the specific paths must be declared before the catch-all `/`.)

Systemd unit sketch (`/etc/systemd/system/blinks-web.service`):

```ini
[Unit]
Description=BLINKS DRM web app (Next.js)
After=network.target

[Service]
WorkingDirectory=/root/BLINKS/drm-web
ExecStart=/usr/bin/npm start
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now blinks-web
```

Deploy update: `cd /root/BLINKS && git pull && cd drm-web && npm ci && npm run build && systemctl restart blinks-web`.

## Before the study

- Set both survey URLs at **build time**. The pre-study questionnaire is
  `https://survey.win.kit.edu/index.php/462485?lang=en` and receives
  `participant_id`; the final questionnaire receives `participantId`.
- Map both parameters to their respective hidden participant-ID question in
  LimeSurvey Panel Integration.
- Verify one complete first-run onboarding and one complete final questionnaire
  on each study browser. Both surveys intentionally open in a new tab; there is
  no iframe or attempt to inspect LimeSurvey's cross-origin completion state.
- New accounts require onboarding by default. Existing accounts are marked
  completed by the migration. See `COMMANDS.md` for targeted resets.
- Completing first-run onboarding stays on the final success screen until the
  participant selects **Log out**. On the evening return, `/reconstruct` first
  shows the Self-DRM instructions; submitting Self DRM shows a second
  instruction screen before the assisted editor and its proposal are loaded.
  This keeps both round timers tied to opening their editor, not reading the
  preceding instructions.

## Code layout

- `src/lib/api-types.ts` — mirrored API contract types (**source of truth is
  `server/src/server.ts`** — update both together).
- `src/lib/api-client.ts` — typed fetch wrapper, token/cookie handling,
  endpoint functions.
- `src/lib/study-config.ts` — survey URLs and their intentionally different
  participant query-parameter names.
- `src/lib/time.ts` — study-timezone helpers (day keys, HH:MM conversion).
- `src/components/reconstruct/` — assisted/self activity rows, frame-picker
  dialog (boundary adjustment + insert), the two pre-round instruction screens,
  round editor with debounced autosave, and read-only view of submitted rounds.
- `src/components/ui/` — generated shadcn/ui components.
