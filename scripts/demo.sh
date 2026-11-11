#!/usr/bin/env bash
# OpenLid local demo. Testnet / local sandbox only.
#
# What it does:
#   1. Refuses to run if OPENLID_NETWORK is mainnet (env or .env).
#   2. Starts the API from apps/api if this tree has it (or uses one already
#      listening on $OPENLID_API_URL). Otherwise explains and offers mock UI.
#   3. Seeds two bills through POST /api/payouts/request:
#        - one small bill to an allowlisted vendor  -> expected "paid"
#        - one unusual bill over the per-bill limit -> expected "held"
#      The held bill is left for the treasurer to approve/reject in the UI.
#   4. Starts the treasurer page (apps/web) on http://127.0.0.1:5173.
#
# Prerequisites:
#   - Node >= 22.18, npm, curl
#   - For a real run: a private .env (copied from .env.example) that the API
#     reads itself. This script never sources .env and never reads key files;
#     it only peeks at the OPENLID_NETWORK line to block mainnet.
#   - DEMO_VENDOR must already be on the contract allowlist (added via
#     propose_allowlist_change + execute_allowlist_change after the 24h delay,
#     or set up in the sandbox/mocked contract state).
#   - DEMO_SMALL_AMOUNT <= per_bill_limit < DEMO_LARGE_AMOUNT, and both fit
#     under the monthly cap. Amounts are USDC atomic units (6 decimals).
#
# Usage:
#   scripts/demo.sh              # start API (if present) + seed + UI
#   scripts/demo.sh --seed-only  # API already running; just seed the two bills
#   scripts/demo.sh --no-ui      # start API + seed, skip the UI
#
# Env overrides (all optional):
#   OPENLID_API_URL     default http://127.0.0.1:8787
#   DEMO_VENDOR         default vendor.openlid-demo.testnet
#   DEMO_SMALL_AMOUNT   default 50000000    (50 USDC)
#   DEMO_LARGE_AMOUNT   default 5000000000  (5,000 USDC)
#
# Gifts are not seeded here: POST /api/gifts/quote calls the live 1Click API,
# and a real deposit address should only be requested when someone intends to
# give. To try it, see "Seeding a gift" in the root README.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_URL="${OPENLID_API_URL:-http://127.0.0.1:8787}"
VENDOR="${DEMO_VENDOR:-vendor.openlid-demo.testnet}"
SMALL="${DEMO_SMALL_AMOUNT:-50000000}"
LARGE="${DEMO_LARGE_AMOUNT:-5000000000}"
LOG_DIR="$ROOT/tmp"
SEED_ONLY=0
NO_UI=0

for arg in "$@"; do
  case "$arg" in
    --seed-only) SEED_ONLY=1 ;;
    --no-ui) NO_UI=1 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'demo: %s\n' "$*" >&2; exit 1; }

# --- safety: never mainnet -------------------------------------------------
network="${OPENLID_NETWORK:-}"
if [[ -z "$network" && -f "$ROOT/.env" ]]; then
  network="$(grep -E '^OPENLID_NETWORK=' "$ROOT/.env" | tail -1 | cut -d= -f2- | tr -d '"'"'"' ' || true)"
fi
if [[ "${network,,}" == "mainnet" ]]; then
  die "OPENLID_NETWORK is mainnet. This demo is testnet / local sandbox only. Aborting."
fi

[[ "$SMALL" =~ ^[0-9]+$ && "$LARGE" =~ ^[0-9]+$ ]] || die "DEMO_*_AMOUNT must be integer strings"
[[ "$VENDOR" =~ ^[a-z0-9._-]+$ ]] || die "DEMO_VENDOR must be a NEAR account id"

command -v node >/dev/null || die "node not found (need Node 22)"
command -v curl >/dev/null || die "curl not found"

mkdir -p "$LOG_DIR"
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && { pkill -P "$p" 2>/dev/null; kill "$p" 2>/dev/null; } || true; done; }
trap cleanup EXIT INT TERM

api_up() { curl -sf "$API_URL/api/summary" >/dev/null 2>&1; }

wait_for() { # url, seconds
  local i
  for ((i = 0; i < $2 * 2; i++)); do curl -sf "$1" >/dev/null 2>&1 && return 0; sleep 0.5; done
  return 1
}

# --- API ------------------------------------------------------------------
HAVE_API=0
if api_up; then
  say "API already running at $API_URL"
  HAVE_API=1
elif [[ $SEED_ONLY -eq 1 ]]; then
  die "--seed-only but no API answering at $API_URL/api/summary"
elif [[ -f "$ROOT/apps/api/package.json" ]]; then
  say "Starting API from apps/api (log: tmp/demo-api.log)"
  ( cd "$ROOT/apps/api"
    [[ -d node_modules ]] || npm install --no-audit --no-fund
    if node -e 'process.exit(require("./package.json").scripts?.start ? 0 : 1)'; then
      exec npm start
    else
      exec npm run dev
    fi
  ) >"$LOG_DIR/demo-api.log" 2>&1 &
  PIDS+=("$!")
  wait_for "$API_URL/api/summary" 60 || { tail -n 30 "$LOG_DIR/demo-api.log" >&2; die "API did not come up at $API_URL"; }
  HAVE_API=1
else
  cat <<EOF

==> No API in this tree (apps/api is missing) and nothing is listening on $API_URL.
    The API is built in the openlid/app worktree and will be here after
    integration. Until then you can view the treasurer page with fixture data:

      cd apps/web && npm install && npm run dev
      open http://127.0.0.1:5173/?mock=1
EOF
fi

# --- seed bills --------------------------------------------------------------
request_payout() { # billId amount memo expected
  local body resp code
  body=$(printf '{"vendor":"%s","amount":"%s","billId":"%s","memo":"%s"}' "$VENDOR" "$2" "$1" "$3")
  resp="$(curl -s -w '\n%{http_code}' -X POST -H 'content-type: application/json' --data "$body" "$API_URL/api/payouts/request")"
  code="${resp##*$'\n'}"
  resp="${resp%$'\n'*}"
  printf '    %s -> HTTP %s %s\n' "$1" "$code" "$resp"
  if [[ "$code" != 2* ]]; then
    echo "    (rejected: check DEMO_VENDOR is allowlisted and amounts fit the limits/cap)"
  elif [[ "$resp" != *"\"status\":\"$4\""* ]]; then
    echo "    (expected status \"$4\"; check per_bill_limit vs DEMO_SMALL_AMOUNT/DEMO_LARGE_AMOUNT)"
  fi
}

if [[ $HAVE_API -eq 1 ]]; then
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  say "Seeding bills for vendor $VENDOR"
  request_payout "demo-auto-$stamp" "$SMALL" "Demo: routine allowlisted bill" paid
  request_payout "demo-hold-$stamp" "$LARGE" "Demo: unusual bill over per-bill limit" held
  echo "    Held bills: $(curl -s "$API_URL/api/holds?status=held")"
fi

[[ $SEED_ONLY -eq 1 ]] && exit 0

# --- UI ---------------------------------------------------------------------
if [[ $NO_UI -eq 0 ]]; then
  say "Starting treasurer page (log: tmp/demo-web.log)"
  ( cd "$ROOT/apps/web"
    [[ -d node_modules ]] || npm install --no-audit --no-fund
    OPENLID_API_URL="$API_URL" exec npx vite --host 127.0.0.1 --port 5173 --strictPort
  ) >"$LOG_DIR/demo-web.log" 2>&1 &
  PIDS+=("$!")
  wait_for "http://127.0.0.1:5173/" 60 || { tail -n 30 "$LOG_DIR/demo-web.log" >&2; die "UI did not start"; }
  if [[ $HAVE_API -eq 1 ]]; then
    echo "    Open http://127.0.0.1:5173/  (if the API has no CORS: http://127.0.0.1:5173/?api=same-origin)"
  else
    echo "    Open http://127.0.0.1:5173/?mock=1  (fixture data, no API)"
  fi
fi

if [[ ${#PIDS[@]} -gt 0 ]]; then
  say "Running. Ctrl-C to stop."
  wait
fi
