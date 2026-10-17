#!/usr/bin/env bash
# Deep Connect — run the relay on this machine, or on any box with Node >= 22.
#
# This is the zero-signup path: no account, no domain, no third party. The relay
# binds a TCP port and both DSH installs dial out to it. It is the right choice
# when the machines share a LAN, a VPN, or a Tailscale-style overlay — and the
# right choice for trying Deep Connect before deciding where it should live.
#
#   ./relay/install.sh                       # LAN / same machine
#   PORT=8790 ./relay/install.sh
#   ./relay/install.sh --public              # also open the port, print the URL
#
# For machines that are NOT on a shared network, see relay/DEPLOY.md. A plain
# port needs either a tunnel (cloudflared) or a real host.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="${NODE:-$(command -v node || true)}"
PORT="${PORT:-8790}"
HOST="${HOST:-0.0.0.0}"
STATE_DIR="${STATE_DIR:-$HOME/.dsh/deep-connect-relay}"
PUBLIC=0
for arg in "$@"; do
  case "$arg" in
    --public) PUBLIC=1 ;;
    --help|-h) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [[ -z "$NODE" ]]; then
  echo "Node.js not found. Install Node >= 22 (the relay needs the built-in WebSocket server APIs and node:zlib is not required, but node:http is)." >&2
  exit 1
fi
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 22 )); then
  echo "Node $("$NODE" -v) is too old; the relay targets Node >= 22." >&2
  exit 1
fi

mkdir -p "$STATE_DIR"
STATE_FILE="$STATE_DIR/relay-state.json"
LOG_FILE="$STATE_DIR/relay.log"
PID_FILE="$STATE_DIR/relay.pid"

# A leftover process would hold the port and make the next start fail confusingly.
if [[ -f "$PID_FILE" ]]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping the previous relay (pid $OLD_PID)"
    kill "$OLD_PID" 2>/dev/null || true
    sleep 0.5
  fi
  rm -f "$PID_FILE"
fi

if [[ "$HOST" == "0.0.0.0" ]]; then
  echo "NOTE: the relay will listen on every interface. Its only credential is the"
  echo "      channel derived from your DeepSeek account, and every payload is"
  echo "      ciphertext, but a public port is still a public port: prefer a VPN or"
  echo "      tunnel unless you intend it to be reachable, and pass --token to"
  echo "      require an extra shared secret."
fi

echo "Starting the relay on $HOST:$PORT"
echo "  state:  $STATE_FILE"
echo "  log:    $LOG_FILE"
nohup "$NODE" "$HERE/relay.cjs" --host "$HOST" --port "$PORT" --state "$STATE_FILE" \
  ${RELAY_TOKEN:+--token "$RELAY_TOKEN"} >>"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"

# Wait for the listener rather than assuming.
for _ in $(seq 1 40); do
  if "$NODE" -e "
    fetch('http://127.0.0.1:$PORT/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));
  " 2>/dev/null; then
    echo "Relay is up."
    break
  fi
  sleep 0.25
done

if ! "$NODE" -e "fetch('http://127.0.0.1:$PORT/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));" 2>/dev/null; then
  echo "The relay did not answer on port $PORT. Last log lines:" >&2
  tail -20 "$LOG_FILE" >&2
  exit 1
fi

# The address the OTHER machine should be given.
LAN_IP=""
for candidate in $(ifconfig 2>/dev/null | awk '/inet /{print $2}' || true); do
  case "$candidate" in
    127.*) continue ;;
    *) LAN_IP="$candidate"; break ;;
  esac
done

echo
if (( PUBLIC )); then
  echo "Point every DSH at:  http://${LAN_IP:-<this-host>}:$PORT"
else
  echo "Point every DSH at one of these:"
  echo "  this machine    http://127.0.0.1:$PORT"
  [[ -n "$LAN_IP" ]] && echo "  other machines  http://$LAN_IP:$PORT"
fi
echo
echo "Then, on every machine: Deep Connect panel -> 设置 -> 中继地址, and check that"
echo "the key fingerprint shown on each machine matches."
echo
echo "Stop with:  kill \$(cat $PID_FILE)"
echo "Follow:     tail -f $LOG_FILE"

if (( PUBLIC )); then
  IP="$(curl -s --max-time 5 https://api.ipify.org || true)"
  if [[ -n "$IP" ]]; then
    echo
    echo "Your public address is $IP. Remember to forward TCP $PORT to this machine,"
    echo "and prefer a tunnel over a raw forwarded port:"
    echo "  cloudflared tunnel --url http://127.0.0.1:$PORT --no-autoupdate"
  fi
fi
