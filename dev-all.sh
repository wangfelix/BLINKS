#!/usr/bin/env bash

# Start the complete BLINKS local development stack in one terminal.
# Metro stays attached directly to the terminal so its QR code and shortcuts work.

set -u

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

RESET=$'\033[0m'
DIM=$'\033[2m'
BOLD=$'\033[1m'
CYAN=$'\033[36m'
YELLOW=$'\033[33m'
GREEN=$'\033[32m'
BLUE=$'\033[34m'
MAGENTA=$'\033[35m'
RED=$'\033[31m'

PIDS=()
PROCESS_NAMES=()
CLEANED_UP=0

info() {
  printf '%s%s[dev-all]%s %s\n' "$BOLD" "$BLUE" "$RESET" "$1"
}

fail() {
  printf '%s%s[dev-all]%s %s\n' "$BOLD" "$RED" "$RESET" "$1" >&2
  exit 1
}

prefix_stream() {
  local label="$1"
  local color="$2"
  local line

  while IFS= read -r line || [[ -n "$line" ]]; do
    printf '%s[%s]%s %s\n' "$color" "$label" "$RESET" "$line"
  done
}

resolve_node_bin() {
  local configured="$1"
  local preferred="$2"

  if [[ -n "$configured" ]]; then
    printf '%s\n' "$configured"
  elif [[ -x "$preferred/node" && -x "$preferred/npm" ]]; then
    printf '%s\n' "$preferred"
  elif command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    dirname "$(command -v node)"
  else
    return 1
  fi
}

check_node_bin() {
  local label="$1"
  local bin_dir="$2"
  local minimum_major="$3"
  local major

  [[ -x "$bin_dir/node" ]] || fail "$label Node executable not found at $bin_dir/node"
  [[ -x "$bin_dir/npm" ]] || fail "$label npm executable not found at $bin_dir/npm"

  major="$("$bin_dir/node" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null)" || \
    fail "$label Node at $bin_dir/node could not be started"
  [[ "$major" =~ ^[0-9]+$ ]] || fail "Could not determine the $label Node version"
  (( major >= minimum_major )) || \
    fail "$label needs Node $minimum_major or newer; found $("$bin_dir/node" --version)"
}

check_file() {
  local path="$1"
  local setup_hint="$2"

  [[ -e "$ROOT_DIR/$path" ]] || fail "Missing $path. $setup_hint"
}

check_executable() {
  local path="$1"
  local setup_hint="$2"

  [[ -x "$ROOT_DIR/$path" ]] || fail "Missing $path. $setup_hint"
}

check_port() {
  local port="$1"
  local service="$2"

  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    fail "Port $port is already in use ($service cannot start). Stop the existing process first."
  fi
}

preflight() {
  check_node_bin "Server" "$SERVER_NODE_BIN" 20
  check_node_bin "App/web" "$APP_NODE_BIN" 22

  command -v ngrok >/dev/null 2>&1 || \
    fail "ngrok is not installed. Install it before starting the backend tunnel."
  ngrok config check >/dev/null 2>&1 || \
    fail "The ngrok configuration is missing or invalid. Run: ngrok config check"

  check_file "server/node_modules/.bin/tsx" "Run: cd server && npm install"
  check_file "drm-web/node_modules/.bin/next" "Run: cd drm-web && npm install"
  check_file "blinks-edge-app/node_modules/.bin/expo" "Run: cd blinks-edge-app && npm install"
  check_executable "server/face-blur/.venv/bin/python" \
    "Create the face-blur virtual environment as documented in COMMANDS.md."
  check_executable "server/vlm/.venv/bin/python" \
    "Create the VLM virtual environment as documented in COMMANDS.md."
  check_file "server/vlm/.env" "Copy server/vlm/.env.example to .env and add KIT_API_KEY."

  check_port 3000 "server"
  check_port 3002 "DRM web app"
  check_port "$PROXY_PORT" "dev proxy"
}

# The free ngrok plan reserves one endpoint, so a single tunnel fronts the dev
# proxy, which splits traffic between the API server and Metro. Ask the local
# ngrok agent API for the public URL it actually got.
resolve_tunnel_url() {
  local attempt
  local url

  for attempt in $(seq 1 30); do
    url="$(curl -fsS http://127.0.0.1:4040/api/tunnels 2>/dev/null \
      | "$APP_NODE_BIN/node" -e '
        let raw = "";
        process.stdin.on("data", (chunk) => (raw += chunk));
        process.stdin.on("end", () => {
          try {
            const tunnels = JSON.parse(raw).tunnels ?? [];
            const https = tunnels.find((tunnel) => tunnel.public_url?.startsWith("https://"));
            process.stdout.write((https ?? tunnels[0])?.public_url ?? "");
          } catch {
            process.stdout.write("");
          }
        });
      ' 2>/dev/null)"
    if [[ -n "$url" ]]; then
      printf '%s\n' "$url"
      return 0
    fi
    sleep 1
  done

  return 1
}

start_prefixed() {
  local label="$1"
  local color="$2"
  local working_dir="$3"
  shift 3

  (
    cd "$ROOT_DIR/$working_dir" || exit 1
    "$@" 2>&1 | prefix_stream "$label" "$color"
  ) &

  PIDS+=("$!")
  PROCESS_NAMES+=("$label")
}

terminate_tree() {
  local parent="$1"
  local child
  local children

  if command -v pgrep >/dev/null 2>&1; then
    children="$(pgrep -P "$parent" 2>/dev/null || true)"
    for child in $children; do
      terminate_tree "$child"
    done
  fi
  kill -TERM "$parent" 2>/dev/null || true
}

cleanup() {
  local pid

  (( CLEANED_UP == 0 )) || return
  CLEANED_UP=1
  trap - INT TERM EXIT

  if (( ${#PIDS[@]} > 0 )); then
    info "Stopping all services..."
    for pid in "${PIDS[@]}"; do
      # npm and dev servers spawn watcher processes; stop the complete tree.
      terminate_tree "$pid"
    done
    for pid in "${PIDS[@]}"; do
      wait "$pid" 2>/dev/null || true
    done
  fi
}

PROXY_PORT="${DEV_PROXY_PORT:-8090}"

SERVER_NODE_BIN="$(resolve_node_bin "${SERVER_NODE_BIN:-}" "$HOME/.nvm/versions/node/v20.18.0/bin")" || \
  fail "No working Node installation found for the server"
APP_NODE_BIN="$(resolve_node_bin "${APP_NODE_BIN:-}" "$HOME/.nvm/versions/node/v22.22.0/bin")" || \
  fail "No working Node installation found for the app and web app"

preflight

if [[ "${1:-}" == "--check" ]]; then
  info "All startup checks passed."
  exit 0
elif [[ $# -gt 0 ]]; then
  fail "Unknown option: $1 (supported: --check)"
fi

trap 'exit 130' INT
trap 'exit 143' TERM
trap cleanup EXIT

info "Starting BLINKS local development stack..."
printf '%sServer%s   http://localhost:3000  (DRM gate open, push disabled)\n' "$CYAN" "$RESET"
printf '%sProxy%s    http://localhost:%s  (API + Metro on one origin)\n' "$YELLOW" "$RESET" "$PROXY_PORT"
printf '%sBackend%s  ngrok http %s\n' "$MAGENTA" "$RESET" "$PROXY_PORT"
printf '%sDRM web%s  http://localhost:3002\n' "$BLUE" "$RESET"
printf '%sMobile%s   Expo dev client over the ngrok tunnel (LAN fallback); QR code will appear below\n' "$MAGENTA" "$RESET"
printf '%sStop everything with Ctrl+C.%s\n\n' "$DIM" "$RESET"

start_prefixed "SERVER" "$CYAN" "server" \
  env PATH="$SERVER_NODE_BIN:$PATH" \
  DRM_AVAILABLE_FROM_HOUR="${DRM_AVAILABLE_FROM_HOUR:-0}" \
  DISABLE_PUSH="${DISABLE_PUSH:-1}" \
  "$SERVER_NODE_BIN/npm" run dev

start_prefixed "PROXY" "$YELLOW" "." \
  env DEV_PROXY_PORT="$PROXY_PORT" "$APP_NODE_BIN/node" dev-proxy.mjs

start_prefixed "NGROK" "$MAGENTA" "." \
  ngrok http "$PROXY_PORT" --log stdout --log-format term

start_prefixed "FACE" "$YELLOW" "server/face-blur" \
  .venv/bin/python blur_worker.py

start_prefixed "VLM" "$GREEN" "server/vlm" \
  .venv/bin/python vlm_worker.py

start_prefixed "WEB" "$BLUE" "drm-web" \
  env PATH="$APP_NODE_BIN:$PATH" "$APP_NODE_BIN/npm" run dev

# Let the other services print their startup messages before Metro draws its QR code.
sleep 1

for index in "${!PIDS[@]}"; do
  if ! kill -0 "${PIDS[$index]}" 2>/dev/null; then
    wait "${PIDS[$index]}" 2>/dev/null
    fail "${PROCESS_NAMES[$index]} exited during startup."
  fi
done

TUNNEL_URL="$(resolve_tunnel_url || true)"

if [[ -n "$TUNNEL_URL" ]]; then
  info "Tunnel ready: $TUNNEL_URL (Metro and the API share this origin)."
  printf '%sThe QR code below points at the tunnel, so the phone works on eduroam or mobile data.%s\n' \
    "$DIM" "$RESET"
else
  printf '\n'
  info "Could not read the ngrok URL from http://127.0.0.1:4040; starting Metro in LAN mode."
  printf '%sLAN mode needs the phone on a network that allows client-to-client traffic (eduroam does not).%s\n' \
    "$YELLOW" "$RESET"
fi

printf '\n%s%s[MOBILE / METRO]%s Interactive output starts here; QR and shortcuts remain usable.\n\n' \
  "$BOLD" "$MAGENTA" "$RESET"

cd "$ROOT_DIR/blinks-edge-app" || fail "Could not enter blinks-edge-app"

# EXPO_PACKAGER_PROXY_URL overrides the advertised dev-server URL, so Metro keeps
# listening on 8081 locally while the QR code and dev-client deep link point at
# the tunnel. Expo's own --tunnel is not used: it runs on Expo's shared ngrok
# account, which is what failed here.
env PATH="$APP_NODE_BIN:$PATH" \
  ${TUNNEL_URL:+EXPO_PACKAGER_PROXY_URL="$TUNNEL_URL"} \
  "$APP_NODE_BIN/npm" run start
METRO_STATUS=$?

exit "$METRO_STATUS"
