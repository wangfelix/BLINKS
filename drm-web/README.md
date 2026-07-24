# drm-web — BLINKS Day Reconstruction web app

Participant-facing evening web app for the DRM subproject (single-day,
two-round design): in the evening of their one field day the participant signs
in and reconstructs that day in **two sequential rounds, fixed order** — step 1
is always Self DRM (from memory, no frames, no VLM output), step 2 unlocks only
after step 1 is submitted and is VLM-assisted (frames + editable auto-segmented
activity list) for the `main` arm or Self DRM again for the `control` arm. Then
the embedded external questionnaire, then offboarding. The order and the
frames/VLM anti-leak are enforced server-side; this app only renders them.

Stack: Next.js (App Router, TypeScript strict, `src/` dir, Tailwind v4) +
shadcn/ui + TanStack Query. The app is a pure client of the BLINKS server API
(`../server`); it has no database or server-side state of its own.

## Pages (a linear pipeline)

| Route          | Purpose                                                             |
| -------------- | ------------------------------------------------------------------- |
| `/`            | Landing + participant login (same credentials as the phone app)     |
| `/reconstruct` | The two-step flow: step progress header + the active round's editor |
| `/survey`      | Embedded LimeSurvey questionnaire with participant-specific URL     |
| `/done`        | Offboarding: thank-you, device-return hint, sign-out                |

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
- For clickable local test data (`demo` = main arm, `democtl` = control arm,
  each with one fully labeled field day), see
  `server/scripts/seed-demo-data.ts`.

Env vars:

| Variable              | Default                 | Meaning                                                 |
| --------------------- | ----------------------- | ------------------------------------------------------- |
| `API_PROXY_TARGET`    | `http://127.0.0.1:3000` | Dev-proxy target for `/api`, `/frames`, `/health`       |
| `DRM_DEV_MODE`        | (off)                   | `1` shows direct dev navigation; set on API server too  |
| `NEXT_PUBLIC_API_URL` | `""` (same origin)      | API base override; normally never needed                |
| `NEXT_PUBLIC_DRM_TZ`  | `Europe/Berlin`         | Study timezone; keep in sync with the server's `DRM_TZ` |

With `DRM_DEV_MODE=1` on both the web app and API server, a floating menu
links directly to Self DRM, VLM-assisted DRM, the survey page, and offboarding.
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

- In LimeSurvey, keep survey embedding enabled and map the Panel Integration
  URL parameter `participantId` to the hidden participant-ID question.
- Serve `blinks.win.kit.edu` over HTTPS before relying on the iframe. As of
  2026-07-21 the app is still HTTP while LimeSurvey is HTTPS; the resulting
  cross-site cookie context can break LimeSurvey sessions in stricter browsers.
- Verify one complete iframe submission and the new-tab fallback on each study
  phone/browser before deployment.

## Code layout

- `src/lib/api-types.ts` — mirrored API contract types (**source of truth is
  `server/src/server.ts`** — update both together).
- `src/lib/api-client.ts` — typed fetch wrapper, token/cookie handling,
  endpoint functions.
- `src/lib/time.ts` — study-timezone helpers (day keys, HH:MM conversion).
- `src/components/reconstruct/` — assisted/self activity rows, frame-picker
  dialog (boundary adjustment + insert), round editor with debounced autosave,
  read-only view of submitted rounds.
- `src/components/ui/` — generated shadcn/ui components.
