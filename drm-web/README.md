# drm-web — BLINKS Day Reconstruction web app

Participant-facing evening web app for the DRM subproject: each evening the
participant signs in, reconstructs their day as a list of activities
(VLM-assisted on `assisted` days, from memory on `control` days), submits it,
and is forwarded to the external daily questionnaire.

Stack: Next.js (App Router, TypeScript strict, `src/` dir, Tailwind v4) +
shadcn/ui + TanStack Query. The app is a pure client of the BLINKS server API
(`../server`); it has no database or server-side state of its own.

## Pages (a linear pipeline)

| Route          | Purpose                                                                     |
| -------------- | --------------------------------------------------------------------------- |
| `/`            | Landing + participant login (same credentials as the phone app)             |
| `/reconstruct` | Day switcher + DayReconstructionPage (assisted or control variant)          |
| `/survey`      | Link to the external daily questionnaire (placeholder URL, new tab)         |
| `/done`        | Offboarding: thank-you, close-tab hint, sign-out                            |

All pages except `/` are guarded client-side (redirect to `/` without a token);
the API additionally enforces auth and the evening availability gate
server-side.

## Auth model

- `POST /api/login` returns a bearer token; it is stored in `localStorage` and
  sent as an `Authorization` header on every JSON request.
- The token is **also** mirrored into a `blinks_token` cookie (`path=/`)
  because `<img>` tags cannot send headers — the server accepts the cookie for
  `GET /frames/*` (images) **only**. JSON APIs stay header-only (CSRF hygiene).
- Any 401 clears the token and redirects to `/`.

## Development

```bash
npm install
NEXT_PUBLIC_API_URL=http://localhost:3000 npm run dev   # http://localhost:3002
```

- Dev server runs on port **3002** (3000 is the BLINKS API, 3001 is this app's
  production port, and Expo/Metro of the phone app tends to sit on 8081+).
- `NEXT_PUBLIC_API_URL` points the app at the API during development. In
  production it is unset: the app calls same-origin paths (`/api/...`,
  `/frames/...`) and Apache routes them to the Node API (see below).
- Note: browsers enforce CORS for cross-origin `fetch`; `localhost:3002` →
  `localhost:3000` is same-site so the image cookie flows, but the JSON API
  must be reachable without CORS errors. If the server does not send CORS
  headers, either add them for dev or run this app behind the same origin as
  the API.

Env vars:

| Variable              | Default          | Meaning                                              |
| --------------------- | ---------------- | ---------------------------------------------------- |
| `NEXT_PUBLIC_API_URL` | `""` (same origin) | API base URL; set for local dev only               |
| `NEXT_PUBLIC_DRM_TZ`  | `Europe/Berlin`  | Study timezone; keep in sync with the server's `DRM_TZ` |

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

- Replace `PLACEHOLDER_SURVEY_URL` in `src/app/survey/page.tsx` with the real
  oTree/LimeSurvey URL.

## Code layout

- `src/lib/api-types.ts` — mirrored API contract types (**source of truth is
  `server/src/server.ts`** — update both together).
- `src/lib/api-client.ts` — typed fetch wrapper, token/cookie handling,
  endpoint functions.
- `src/lib/time.ts` — study-timezone helpers (day keys, HH:MM conversion).
- `src/components/reconstruct/` — day switcher, assisted/control activity
  rows, frame-picker dialog (boundary adjustment + insert), day editor with
  debounced autosave, read-only view of submitted days.
- `src/components/ui/` — generated shadcn/ui components.
