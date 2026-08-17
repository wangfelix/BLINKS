# Deployment config (KIT VM, blinks.win.kit.edu)

The Apache vhosts and systemd units that run BLINKS in production. These files
are the source of truth. Copy them onto the VM rather than editing the copies
under `/etc/` in place, so a rebuild of the VM is reproducible.

Host: `root@129.13.238.199`, repo at `/root/BLINKS`, Ubuntu 26.04, Node 22.

## Processes

| Unit | Port | What it is |
| --- | --- | --- |
| `blinks` | 3000 | `server/` — API + WebSocket ingestion |
| `blinks-web` | 3001 | `drm-web/` — participant website (Next.js standalone) |
| `blinks-face-blur` | — | `server/face-blur/` — Python worker, polls the DB |
| `blinks-vlm` | — | `server/vlm/` — Python worker, polls the DB |

Apache terminates TLS and routes `/api`, `/ingest`, `/frames`, `/health` to
3000 and everything else to 3001. Only 22/80/443 are open in ufw; 3000 and 3001
are localhost-only.

The face-blur worker is not optional. The server's serving gate hides every
frame whose `face_status` is not `done`, so if it is stopped, the app and the
website show no images at all.

## One-time host prerequisites

The current KIT VM already has these prerequisites. On a replacement host,
install Node 20+ at `/usr/bin/node`, npm, Python 3 with `venv`, Apache, certbot,
and curl; obtain the Let's Encrypt certificate before the first scripted
deploy. Also create the two gitignored production files:

- `drm-web/.env.local` with both real LimeSurvey URLs and the payout URL.
- `server/vlm/.env` with a non-empty `KIT_API_KEY`.

The deploy script installs and enables the tracked systemd units, required
Apache modules, and both sites. The equivalent manual setup is:

```bash
cp deploy/systemd/*.service /etc/systemd/system/
cp deploy/apache/*.conf /etc/apache2/sites-available/
a2ensite blinks blinks-le-ssl
a2enmod proxy proxy_http proxy_wstunnel headers ssl rewrite
apache2ctl configtest && systemctl reload apache2
systemctl daemon-reload
systemctl enable --now blinks blinks-web blinks-face-blur blinks-vlm
```

The TLS certificate is Let's Encrypt via certbot (`certbot --apache -d
blinks.win.kit.edu`); `blinks-le-ssl.conf` references the paths certbot
manages and renewal is handled by `certbot.timer`.

Secrets are not in this repo: `KIT_API_KEY` lives in `server/vlm/.env`
(gitignored), and participant credentials live in `server/data/auth.db`.

## Routine redeploy

```bash
cd /root/BLINKS
git pull --ff-only
/root/BLINKS/deploy/deploy.sh
```

`deploy.sh` builds both Node apps, refreshes the worker venvs, syncs the units
and vhosts in this directory into `/etc`, restarts all four services, and health-
checks them through Apache. Options: `--pull` (git pull first), `--skip-python`,
`--skip-config`, `--help`.

Design points worth knowing:

- **Builds run before any restart.** A TypeScript error aborts the deploy with
  production still serving the previous version.
- **Only a clean, tracked checkout is deployable.** Local tracked edits abort
  before building, and `deploy/deploy.sh` itself must have arrived through Git.
- **`drm-web/.env.local` is checked first.** `NEXT_PUBLIC_*` is inlined at build
  time, while the payout redirect reads `PAYOUT_URL` from the web service's
  environment at runtime. A missing file or required URL aborts deployment.
- **Standalone assets are removed before copying.** `cp -r public .next/standalone/`
  onto an existing directory nests it as `public/public` rather than merging, so
  the script deletes `public` and `.next/static` in the standalone tree first.
- **Apache changes roll back on their own.** Vhosts are backed up, `configtest`
  runs before any reload, and a rejected config restores the previous files.
- **A dead `blinks-face-blur` is treated as a failure**, not a warning. The
  serving gate hides every frame until that worker marks it done, so if it is
  down, participants see no photos at all.
- **Both SQLite databases are backed up online before restart.** Consistent,
  `quick_check`-verified snapshots are written to
  `/root/BLINKS-backups/<UTC timestamp>-<git SHA>-<random>/` before startup
  migrations.
- **Push behavior is deployment-checked.** The server push regression test runs
  during the build, and `/health` must report an enabled scheduler with a
  30-minute lead before the deploy succeeds.

To roll back, check out the previous commit and run it again; the script prints
the deployed SHA at the start of every run.

## Verify

```bash
systemctl is-active blinks blinks-web blinks-face-blur blinks-vlm
curl -s https://blinks.win.kit.edu/health          # JSON from :3000
curl -sI https://blinks.win.kit.edu/ | head -1     # HTML from :3001
journalctl -u blinks -f
```

The health check proves that the server scheduler is enabled; it cannot prove
delivery to a particular phone. Before the study, use the freshly rebuilt
native Android app, sign in once with notification permission granted, and send
one real test reminder through Expo/FCM. The app needs valid EAS/FCM credentials
and must have registered an `ExpoPushToken` in the participant profile.

## Backups

`server/recordings/` (JPEGs + `recordings.db`) and `server/data/auth.db` hold
all state. Deploy-time database snapshots live outside the checkout under
`/root/BLINKS-backups/`; they do not duplicate the JPEGs. Everything else is
rebuildable from git. See COMMANDS.md for pulling a copy to a workstation.
