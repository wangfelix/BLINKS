#!/usr/bin/env bash
#
# BLINKS production deploy (KIT VM, blinks.win.kit.edu).
#
# Run on the VM as root, after the repo is at the commit you want:
#
#     /root/BLINKS/deploy/deploy.sh
#     /root/BLINKS/deploy/deploy.sh --pull      # git pull first
#
# Everything is built BEFORE anything is restarted, so a compile error leaves
# the running system untouched. See deploy/README.md.

set -euo pipefail

REPO="${REPO:-/root/BLINKS}"
BACKUP_ROOT="${BACKUP_ROOT:-/root/BLINKS-backups}"
SERVICES=(blinks blinks-web blinks-face-blur blinks-vlm)
DO_PULL=0
SKIP_PYTHON=0
SKIP_CONFIG=0

for arg in "$@"; do
  case "$arg" in
    --pull) DO_PULL=1 ;;
    --skip-python) SKIP_PYTHON=1 ;;
    --skip-config) SKIP_CONFIG=1 ;;
    -h|--help)
      cat <<'USAGE'
BLINKS production deploy (KIT VM, blinks.win.kit.edu). Run on the VM as root,
with the repo already at the commit you want.

  deploy.sh                 build, sync config, restart, health-check
  deploy.sh --pull          git pull --ff-only first
  deploy.sh --skip-python   leave the two worker venvs untouched (faster)
  deploy.sh --skip-config   do not touch /etc systemd units or apache vhosts

Everything is built before anything is restarted, so a compile error leaves the
running system untouched. See deploy/README.md.
USAGE
      exit 0
      ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
require_command() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }

[ "$(id -u)" -eq 0 ] || die "must run as root (systemctl + /etc writes)"
[ -d "$REPO/server" ] && [ -d "$REPO/drm-web" ] || die "no BLINKS checkout at $REPO"

for command in git node npm python3 curl systemctl install cmp mktemp; do
  require_command "$command"
done
if [ "$SKIP_CONFIG" -eq 0 ]; then
  for command in apache2ctl a2dissite a2enmod a2ensite systemd-analyze; do
    require_command "$command"
  done
fi
[ -x /usr/bin/node ] || die "systemd runtime /usr/bin/node is missing"
NODE_MAJOR="$(/usr/bin/node -p 'Number(process.versions.node.split(".")[0])')"
[ "$NODE_MAJOR" -ge 20 ] || die "/usr/bin/node must be Node 20+ (found $(/usr/bin/node --version))"

cd "$REPO"

# ---------------------------------------------------------------- preflight --

git ls-files --error-unmatch deploy/deploy.sh >/dev/null 2>&1 \
  || die "deploy/deploy.sh is not tracked — commit and push deploy/ before deploying"

TRACKED_CHANGES="$(git status --porcelain --untracked-files=no)"
[ -z "$TRACKED_CHANGES" ] \
  || die "tracked checkout changes exist; commit, stash, or revert them before deployment"

PREVIOUS_SHA="$(git rev-parse --short HEAD)"
if [ "$DO_PULL" -eq 1 ]; then
  log "git pull"
  git pull --ff-only
fi

TRACKED_CHANGES="$(git status --porcelain --untracked-files=no)"
[ -z "$TRACKED_CHANGES" ] \
  || die "git pull left tracked checkout changes; refusing a mixed deployment"

BEFORE_SHA="$(git rev-parse --short HEAD)"
log "deploying $BEFORE_SHA ($(git log -1 --format=%s)); checkout was at $PREVIOUS_SHA"
# A plain code rollback is NOT enough across a startup schema migration: e.g.
# the activity_ratings migration (BLINKS-tasks#4) drops workload_rating /
# recovery_rating, and older code then fails in initDb. Full procedure in
# deploy/README.md ("Rollback"): stop the services, restore recordings.db (and
# auth.db if needed) from the snapshot this run writes below, delete the
# -wal/-shm files, then check out and deploy the old commit.
echo "    rollback: see deploy/README.md#rollback (stop services, restore DB snapshot"
echo "    from $BACKUP_ROOT/<stamp>-$BEFORE_SHA-*/, delete -wal/-shm, deploy the old commit)"

# Study config (BLINKS-tasks#4): every study setting, the survey/payout links
# and the Study Settings PIN live in the gitignored config/study.yaml. The
# server and both workers refuse to start without a valid file in production
# (no fallback to study.example.yaml), so check it before building anything.
# It is validated after the builds below (same loaders as at runtime).
STUDY_CONFIG="$REPO/config/study.yaml"
[ -f "$STUDY_CONFIG" ] && [ ! -L "$STUDY_CONFIG" ] \
  || die "config/study.yaml is missing (or a symlink) — the server would not start.
       cp config/study.example.yaml config/study.yaml, fill in the real survey/payout
       links and a new PIN (see config/README.md), then chmod 600 config/study.yaml."
git ls-files --error-unmatch config/study.yaml >/dev/null 2>&1 \
  && die "config/study.yaml is tracked by git — it holds the PIN and survey links; untrack it"
# Holds the Study Settings PIN and the payout/survey links: owner-only. The
# services run as root, so group read (640) is never needed.
STUDY_CONFIG_MODE="$(stat -c %a "$STUDY_CONFIG")"
[ "$((8#$STUDY_CONFIG_MODE & 8#077))" -eq 0 ] \
  || warn "config/study.yaml is readable by group/others (mode $STUDY_CONFIG_MODE); chmod 600 config/study.yaml"
grep -qE 'example\.(org|com)' "$STUDY_CONFIG" \
  && die "config/study.yaml still contains example.org/example.com placeholder links"
# Placeholder PIN from study.example.yaml or the retired pre-config PIN (by
# SHA-256, not in clear text). The loaders enforce the same rule in production
# (review of PR #1, m2); this early check fails before any build.
study_pin() { sed -nE 's/^[[:space:]]*studySettingsPin:[[:space:]]*["'"'"']?([0-9]+)["'"'"']?.*/\1/p' "$1" | head -1; }
STUDY_PIN="$(study_pin "$STUDY_CONFIG")"
[ -n "$STUDY_PIN" ] || die "config/study.yaml has no app.studySettingsPin"
[ "$STUDY_PIN" != "$(study_pin "$REPO/config/study.example.yaml")" ] \
  || die "config/study.yaml still uses the placeholder Study Settings PIN from study.example.yaml"
RETIRED_PIN_SHA256="305800b71062b49b350208327a02ec378199b4cf35e60eeb971611bef4928394"
[ "$(printf '%s' "$STUDY_PIN" | sha256sum | cut -d' ' -f1)" != "$RETIRED_PIN_SHA256" ] \
  || die "config/study.yaml uses the retired Study Settings PIN (public in git history); set a new one"
unset STUDY_PIN

# Transitional: as long as drm-web still builds the survey links from env
# (before it reads GET /api/study-config), keep requiring them in .env.local.
# NEXT_PUBLIC_* is inlined at build time, so a missing value would fail silently.
if grep -rqE 'NEXT_PUBLIC_(ONBOARDING|FINAL)_SURVEY_URL|process\.env\.PAYOUT_URL' "$REPO/drm-web/src"; then
  warn "drm-web still reads survey/payout links from env; checking drm-web/.env.local (legacy)"
  [ -f "$REPO/drm-web/.env.local" ] || die "drm-web/.env.local is missing (legacy web survey links)"
  for v in NEXT_PUBLIC_ONBOARDING_SURVEY_URL NEXT_PUBLIC_FINAL_SURVEY_URL PAYOUT_URL; do
    grep -qE "^${v}=.+" "$REPO/drm-web/.env.local" || die "$v is unset in drm-web/.env.local"
  done
elif [ -f "$REPO/drm-web/.env.local" ] \
  && grep -qE '^(NEXT_PUBLIC_(ONBOARDING|FINAL)_SURVEY_URL|PAYOUT_URL|NEXT_PUBLIC_DRM_TZ)=' "$REPO/drm-web/.env.local"; then
  warn "drm-web/.env.local still sets survey/payout/timezone vars; they are unused now (config/study.yaml) and can be removed"
fi

if [ ! -f "$REPO/server/vlm/.env" ]; then
  die "server/vlm/.env is missing — the VLM worker has no KIT_API_KEY."
fi
grep -qE '^[[:space:]]*KIT_API_KEY=.+$' "$REPO/server/vlm/.env" \
  || die "KIT_API_KEY is unset in server/vlm/.env"

if [ "$SKIP_CONFIG" -eq 0 ]; then
  [ -r /etc/letsencrypt/live/blinks.win.kit.edu/fullchain.pem ] \
    || die "Let's Encrypt full chain is missing for blinks.win.kit.edu"
  [ -r /etc/letsencrypt/live/blinks.win.kit.edu/privkey.pem ] \
    || die "Let's Encrypt private key is missing for blinks.win.kit.edu"
fi

# ------------------------------------------------------------------- builds --
# Nothing below restarts a service. If any build fails, prod keeps running the
# previous version.

log "building server/"
cd "$REPO/server"
npm ci --include=dev
npm run build
npm run test-push
[ -f dist/server.js ] || die "server build produced no dist/server.js"
git -C "$REPO" diff --quiet -- server/dist \
  || die "server build changed tracked dist/ output; build and commit dist/ before production deployment"

log "validating config/study.yaml (server loader, production rules)"
# Same loader the service runs: exit 2 + "path: reason" lines on any problem.
env -u BLINKS_STUDY_CONFIG NODE_ENV=production /usr/bin/node -e '
  const { studyConfig } = require("./dist/study-config/index.js");
  const b = studyConfig.reminders.bedtime;
  console.log(`    ok  ${studyConfig.study.name} (${studyConfig.study.timezone}), ` +
    `faceBlur=${studyConfig.privacy.faceBlur.enabled}, overreliance=${studyConfig.overreliance.enabled}, ` +
    `bedtime push=${b.enabled} (lead ${b.leadMinutes} min)`);
' || die "config/study.yaml is invalid (see the lines above); nothing was restarted"
# Values the health checks below depend on.
FACE_BLUR_ENABLED="$(env -u BLINKS_STUDY_CONFIG NODE_ENV=production /usr/bin/node -p \
  'require("./dist/study-config/index.js").studyConfig.privacy.faceBlur.enabled')"
PUSH_EXPECT="$(env -u BLINKS_STUDY_CONFIG NODE_ENV=production /usr/bin/node -p '
  const b = require("./dist/study-config/index.js").studyConfig.reminders.bedtime;
  JSON.stringify({ enabled: b.enabled, leadMinutes: b.leadMinutes })')"

log "building drm-web/"
cd "$REPO/drm-web"
npm ci --include=dev
npm run build
[ -f .next/standalone/server.js ] || die "drm-web build produced no standalone server.js"

# next.config.ts uses output:"standalone", which excludes public/ and
# .next/static. Remove the destinations first: `cp -r public .next/standalone/`
# onto an existing directory nests it as public/public instead of merging.
log "copying standalone assets"
STANDALONE_DIR="$REPO/drm-web/.next/standalone"
[ -d "$STANDALONE_DIR" ] && [ ! -L "$STANDALONE_DIR" ] \
  || die "standalone output is missing or is a symbolic link"
[ ! -L "$STANDALONE_DIR/public" ] \
  || die "refusing to replace symlink: $STANDALONE_DIR/public"
[ ! -L "$STANDALONE_DIR/.next/static" ] \
  || die "refusing to replace symlink: $STANDALONE_DIR/.next/static"
rm -rf -- "$STANDALONE_DIR/public" "$STANDALONE_DIR/.next/static"
cp -r "$REPO/drm-web/public" "$STANDALONE_DIR/"
cp -r "$REPO/drm-web/.next/static" "$STANDALONE_DIR/.next/"

if [ "$SKIP_PYTHON" -eq 0 ]; then
  for worker in face-blur vlm; do
    log "python deps: server/$worker"
    cd "$REPO/server/$worker"
    [ -d .venv ] || python3 -m venv .venv
    .venv/bin/pip install --quiet --upgrade pip
    .venv/bin/pip install --quiet -r requirements.txt
  done
fi

log "validating config/study.yaml (Python worker loader)"
for worker in face-blur vlm; do
  [ -x "$REPO/server/$worker/.venv/bin/python" ] \
    || die "server/$worker/.venv is missing — run without --skip-python once"
  ( cd "$REPO/server" && env -u BLINKS_STUDY_CONFIG BLINKS_ENV=production \
      "$REPO/server/$worker/.venv/bin/python" -c \
      'import blinks_study_config as b; b.load_study_config_or_exit("    "); print("    ok  python loader")' ) \
    || die "config/study.yaml rejected by the $worker worker loader; nothing was restarted"
done

# The server applies SQLite migrations on startup. Take transactionally
# consistent online backups before restarting so a schema regression can be
# recovered without copying a live WAL database by hand.
log "backing up SQLite state"
[ ! -L "$BACKUP_ROOT" ] || die "backup root must not be a symbolic link: $BACKUP_ROOT"
BACKUP_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 700 "$BACKUP_ROOT"
BACKUP_DIR="$(mktemp -d "$BACKUP_ROOT/$BACKUP_STAMP-$BEFORE_SHA-XXXXXX")"
python3 - "$REPO" "$BACKUP_DIR" <<'PY'
import os
import sqlite3
import sys
from pathlib import Path

repo = Path(sys.argv[1]).resolve()
backup_dir = Path(sys.argv[2]).resolve()
databases = (
    (repo / "server/recordings/recordings.db", "recordings.db"),
    (repo / "server/data/auth.db", "auth.db"),
)

for source, name in databases:
    if not source.is_file():
        print(f"    skipped {name} (database does not exist yet)")
        continue
    destination = backup_dir / name
    with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as source_db:
        with sqlite3.connect(destination) as backup_db:
            source_db.backup(backup_db)
            result = backup_db.execute("PRAGMA quick_check").fetchone()
            if result is None or result[0] != "ok":
                raise RuntimeError(f"quick_check failed for {name}: {result}")
    os.chmod(destination, 0o600)
    print(f"    backed up {source} -> {destination}")
PY

# ------------------------------------------------------------------- config --

if [ "$SKIP_CONFIG" -eq 0 ]; then
  log "syncing systemd units"
  systemd-analyze verify "$REPO"/deploy/systemd/*.service
  install -m 644 "$REPO"/deploy/systemd/*.service /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable "${SERVICES[@]}"

  log "syncing apache vhosts"
  STAMP="$(date +%F-%H%M%S)"
  APACHE_CHANGED=0
  APACHE_NEW_TARGETS=()
  BLINKS_SITE_WAS_ENABLED=0
  BLINKS_SSL_SITE_WAS_ENABLED=0
  [ -e /etc/apache2/sites-enabled/blinks.conf ] && BLINKS_SITE_WAS_ENABLED=1
  [ -e /etc/apache2/sites-enabled/blinks-le-ssl.conf ] && BLINKS_SSL_SITE_WAS_ENABLED=1
  for conf in "$REPO"/deploy/apache/*.conf; do
    target="/etc/apache2/sites-available/$(basename "$conf")"
    if ! cmp -s "$conf" "$target"; then
      if [ -f "$target" ]; then
        cp "$target" "$target.bak-$STAMP"
      else
        APACHE_NEW_TARGETS+=("$target")
      fi
      install -m 644 "$conf" "$target"
      APACHE_CHANGED=1
      echo "    updated $(basename "$conf")"
    fi
  done

  a2enmod proxy proxy_http proxy_wstunnel headers ssl rewrite >/dev/null
  a2ensite blinks blinks-le-ssl >/dev/null

  if [ "$APACHE_CHANGED" -eq 0 ]; then
    echo "    apache vhosts already current"
  fi
  if apache2ctl configtest; then
    systemctl reload apache2
  else
    warn "apache configtest FAILED — restoring previous vhosts"
    for bak in /etc/apache2/sites-available/*.bak-"$STAMP"; do
      [ -f "$bak" ] || continue
      mv "$bak" "${bak%.bak-$STAMP}"
    done
    for target in "${APACHE_NEW_TARGETS[@]}"; do
      [ -f "$target" ] && rm -f -- "$target"
    done
    [ "$BLINKS_SITE_WAS_ENABLED" -eq 1 ] \
      || a2dissite blinks >/dev/null 2>&1 || true
    [ "$BLINKS_SSL_SITE_WAS_ENABLED" -eq 1 ] \
      || a2dissite blinks-le-ssl >/dev/null 2>&1 || true
    die "apache config rejected; vhosts restored, nothing reloaded"
  fi
fi

# ----------------------------------------------------------------- restarts --

log "restarting services"
if ! systemctl restart "${SERVICES[@]}"; then
  warn "one or more restart jobs failed; checking every service and collecting logs"
fi
sleep 4

FAILED=0
for svc in "${SERVICES[@]}"; do
  if [ "$svc" = "blinks-face-blur" ] && [ "$FACE_BLUR_ENABLED" != "true" ]; then
    # privacy.faceBlur.enabled=false: the worker anonymizes any remaining
    # pending backlog once and then exits 0 (Restart=on-failure keeps it down).
    printf '    \033[1;33mdisabled\033[0m %s (privacy.faceBlur.enabled=false)\n' "$svc"
    continue
  fi
  if systemctl is-active --quiet "$svc"; then
    printf '    \033[1;32mok\033[0m       %s\n' "$svc"
  else
    printf '    \033[1;31mFAILED\033[0m   %s\n' "$svc"
    FAILED=1
  fi
done

if [ "$FAILED" -eq 1 ]; then
  warn "at least one service is down — recent logs:"
  journalctl -u blinks -u blinks-web -u blinks-face-blur -u blinks-vlm \
    --since '2 min ago' --no-pager | tail -40
  die "deploy incomplete"
fi

# --------------------------------------------------------------- healthcheck --

log "health checks"

check() {
  local label="$1" url="$2" expect="$3"
  local body
  if body="$(curl -fsS --max-time 10 "$url" 2>&1)" && [[ "$body" == *"$expect"* ]]; then
    printf '    \033[1;32mok\033[0m       %s\n' "$label"
  else
    printf '    \033[1;31mFAILED\033[0m   %s (%s)\n' "$label" "$url"
    FAILED=1
  fi
}

check "api  (:3000)"        "http://127.0.0.1:3000/health" '"status":"ok"'
check "push scheduler"      "http://127.0.0.1:3000/health" "\"pushScheduler\":$PUSH_EXPECT"
check "web  (:3001)"        "http://127.0.0.1:3001/"       '<html'
check "api  (via https)"    "https://blinks.win.kit.edu/health" '"status":"ok"'
check "web  (via https)"    "https://blinks.win.kit.edu/"       '<html'

# The face-blur worker owns the serving gate: frames stay hidden until it marks
# them done, so a silently dead worker means participants see no photos at all.
if [ "$FACE_BLUR_ENABLED" = "true" ]; then
  if ! systemctl is-active --quiet blinks-face-blur; then
    warn "blinks-face-blur is not running — NO frames will be served to anyone"
    FAILED=1
  fi
else
  warn "privacy.faceBlur.enabled=false — new frames are stored and served WITHOUT face anonymization"
fi

[ "$FAILED" -eq 0 ] || die "deployed, but health checks failed — investigate before the study"

log "deploy complete ($BEFORE_SHA)"
