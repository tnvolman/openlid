#!/usr/bin/env bash
# OpenLid demo. NEAR TESTNET ONLY. $0 spend: no mainnet accounts, no real
# funds, no paid APIs.
#
# The cross-chain leg is NOT real: it is a dry-run 1Click quote (dry: true,
# no deposit address, nothing is ever deposited) plus a simulated settlement
# that mints a test FT (tUSDC) into the treasury contract on NEAR testnet.
#
# Steps:
#   1. Refuse unless the network is testnet.
#   2. scripts/testnet/setup.mjs: create (or reuse) a <name>.testnet account
#      from the free testnet faucet plus agent/vendor/treasury/tusdc
#      sub-accounts. Keys are generated locally into .demo-keys/ (gitignored)
#      and never printed. Deploy the treasury and test-FT wasm if built.
#      If faucet or deploy cannot run, stop here and say why. Nothing is faked.
#   3. Create the treasurer approval secret if absent: 32 random bytes (hex)
#      in .demo-keys/approval.env (mode 600, gitignored, never printed; not in
#      demo.env). Start apps/api with .demo-keys/demo.env (ids and key-file
#      paths only) plus OPENLID_APPROVAL_SECRET from approval.env,
#      ONECLICK_API_KEY unset and ONECLICK_DRY_RUN=true.
#   4. POST /api/gifts/quote (dry-run, missions fund), then
#      POST /api/gifts/:id/simulate-settlement for that gift: mints tUSDC into
#      the treasury and the owner records it in the missions fund ledger
#      (credit_fund).
#   5. Seed one small allowlisted bill (expected: paid) and one unusual bill
#      over the per-bill limit (expected: held) via POST /api/payouts/request,
#      both from the missions fund ("fund":"missions"). The contract only pays
#      a bill from its own fund's balance.
#      The treasurer approves the held bill with the X-OpenLid-Approval
#      header (the agent's payout requests never carry it).
#   6. Start the treasurer page on http://127.0.0.1:5173 with
#      VITE_OPENLID_APPROVAL_SECRET from approval.env, so its approve/reject
#      calls send the header. This is a local demo control, not real auth.
#
# Prerequisites: Node >= 22.18, npm, curl, git; internet access to a NEAR
# testnet RPC (default rpc.testnet.fastnear.com; override with
# OPENLID_NEAR_RPC_URL) and the testnet faucet; built contract wasm for
# contracts/treasury and contracts/test-ft; apps/api present.
#
# Usage:
#   scripts/demo.sh            # full run; leaves API (and UI) up until Ctrl-C
#   scripts/demo.sh --no-ui    # skip starting the UI
#   scripts/demo.sh --once     # run the gift, settlement, bills, and treasurer
#                               approve, print the transcript, then exit
#
# Env overrides (optional):
#   OPENLID_API_URL       default http://127.0.0.1:8787
#   OPENLID_DEMO_KEYS_DIR default .demo-keys
#   DEMO_SMALL_AMOUNT     default 50000000   (50 tUSDC, under the 100 tUSDC per-bill limit)
#   DEMO_LARGE_AMOUNT     default 500000000  (500 tUSDC, over the limit, under the cap)
#   DEMO_GIFT_AMOUNT      default 600000000  (tUSDC minted and credited to the missions fund; must cover both bills)
#   DEMO_ORIGIN_ASSET     default nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near
#
# Key safety: this script never prints key material or the approval secret
# and never sources the repo .env. It reads only the OPENLID_NETWORK line of
# .env to block mainnet. Delete .demo-keys/approval.env to rotate the secret.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_URL="${OPENLID_API_URL:-http://127.0.0.1:8787}"
KEYS_DIR="$ROOT/${OPENLID_DEMO_KEYS_DIR:-.demo-keys}"
SMALL="${DEMO_SMALL_AMOUNT:-50000000}"
LARGE="${DEMO_LARGE_AMOUNT:-500000000}"
GIFT_AMOUNT="${DEMO_GIFT_AMOUNT:-600000000}"
ORIGIN_ASSET="${DEMO_ORIGIN_ASSET:-nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near}"
LOG_DIR="$ROOT/tmp"
NO_UI=0
ONCE=0

for arg in "$@"; do
  case "$arg" in
    --no-ui) NO_UI=1 ;;
    --once) ONCE=1; NO_UI=1 ;;
    -h|--help) sed -n '2,56p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\ndemo: %s\n' "$1" >&2; exit "${2:-1}"; }
# JSON field from stdin, via node (no jq dependency). Prints "" if missing.
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));process.stdout.write(v==null?"":String(v))}catch{}})' "$1"; }

cat <<'EOF'
==================================================================
 OpenLid demo: NEAR TESTNET ONLY, $0 spend.
 The cross-chain leg is a dry-run 1Click quote plus a simulated
 settlement on NEAR testnet. No mainnet accounts, no real funds,
 no paid APIs, no deposit is ever sent. Receipts and exports are
 labeled: demo, not a tax document.
==================================================================
EOF

# --- 1. testnet only ------------------------------------------------------
network="${OPENLID_NETWORK:-}"
if [[ -z "$network" && -f "$ROOT/.env" ]]; then
  network="$(grep -E '^OPENLID_NETWORK=' "$ROOT/.env" | tail -1 | cut -d= -f2- | tr -d '"'"'"' ' || true)"
fi
network="${network:-testnet}"
[[ "${network,,}" == "testnet" ]] || die "OPENLID_NETWORK=$network. This demo runs on NEAR testnet only. Aborting."
export OPENLID_NETWORK=testnet

[[ "$SMALL" =~ ^[0-9]+$ && "$LARGE" =~ ^[0-9]+$ && "$GIFT_AMOUNT" =~ ^[0-9]+$ ]] || die "DEMO_*_AMOUNT must be integer strings"
for c in node npm curl git; do command -v "$c" >/dev/null || die "$c not found"; done

mkdir -p "$LOG_DIR"
PIDS=()
# Job control: each background job gets its own process group, so cleanup
# stops npm and everything it spawned.
set -m
cleanup() { for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && kill -- "-$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

wait_for() { # url seconds
  local i
  for ((i = 0; i < $2 * 2; i++)); do curl -sf "$1" >/dev/null 2>&1 && return 0; sleep 0.5; done
  return 1
}

# --- 2. testnet accounts, keys, contracts ----------------------------------
say "Testnet accounts (faucet) and contracts"
[[ -d "$ROOT/scripts/testnet/node_modules" ]] || (cd "$ROOT/scripts/testnet" && npm ci --no-audit --no-fund >/dev/null)
set +e
OPENLID_DEMO_KEYS_DIR="$KEYS_DIR" node "$ROOT/scripts/testnet/setup.mjs"
rc=$?
set -e
case $rc in
  0) ;;
  3) die "Testnet accounts exist, but the treasury / test-FT contracts could not be deployed (see above).
Stopping before any gift, settlement, or bill: there is no contract to settle into
or pay from, and this demo does not fake testnet receipts. See README > Known issues." 3 ;;
  *) die "Testnet setup failed (exit $rc). Nothing was faked. See README > Known issues." "$rc" ;;
esac
DEMO_ENV="$KEYS_DIR/demo.env"
[[ -f "$DEMO_ENV" ]] || die "missing $DEMO_ENV"
DEMO_VENDOR="$(grep -E '^DEMO_VENDOR=' "$DEMO_ENV" | cut -d= -f2-)"

# --- 3. approval secret, then API ---------------------------------------------
# Treasurer approval secret for approve/reject (X-OpenLid-Approval). Kept out of
# demo.env (setup.mjs owns that file) in its own mode-600 file. Never printed.
APPROVAL_ENV="$KEYS_DIR/approval.env"
if [[ ! -s "$APPROVAL_ENV" ]]; then
  ( umask 077
    node -e 'process.stdout.write("OPENLID_APPROVAL_SECRET="+require("node:crypto").randomBytes(32).toString("hex")+"\n")' >"$APPROVAL_ENV" )
fi
chmod 600 "$APPROVAL_ENV"
APPROVAL_SECRET="$(grep -E '^OPENLID_APPROVAL_SECRET=' "$APPROVAL_ENV" | tail -1 | cut -d= -f2-)"
[[ "$APPROVAL_SECRET" =~ ^[0-9a-f]{64}$ ]] || die "$APPROVAL_ENV is malformed; delete it and re-run to generate a new approval secret"

if curl -sf "$API_URL/api/summary" >/dev/null 2>&1; then
  die "Something is already listening on $API_URL. Stop it so the demo can start the API
with the testnet config (dry-run 1Click, no API key)."
fi
[[ -f "$ROOT/apps/api/package.json" ]] || die "apps/api is not in this tree, so the API cannot start.
The testnet accounts above are real and reusable; re-run after integration." 4

say "Starting API from apps/api (log: tmp/demo-api.log)"
(
  set -a
  # demo.env holds account ids and key-file paths only (written by setup.mjs).
  # shellcheck disable=SC1090
  . "$DEMO_ENV"
  set +a
  unset ONECLICK_API_KEY # $0 demo: never call the paid live 1Click endpoint
  export ONECLICK_DRY_RUN=true OPENLID_NETWORK=testnet OPENLID_APPROVAL_SECRET="$APPROVAL_SECRET"
  cd "$ROOT/apps/api"
  [[ -d node_modules ]] || npm install --no-audit --no-fund
  if node -e 'process.exit(require("./package.json").scripts?.start ? 0 : 1)'; then exec npm start; else exec npm run dev; fi
) >"$LOG_DIR/demo-api.log" 2>&1 &
PIDS+=("$!")
wait_for "$API_URL/api/summary" 60 || { tail -n 30 "$LOG_DIR/demo-api.log" >&2; die "API did not come up at $API_URL"; }

post() { curl -s -w '\n%{http_code}' -X POST -H 'content-type: application/json' --data "$2" "$API_URL$1"; }
# Treasurer-only POST: the approval header goes in on stdin (-H @-), so the
# secret is not on any command line and is never echoed.
post_treasurer() { printf 'X-OpenLid-Approval: %s\n' "$APPROVAL_SECRET" | curl -s -w '\n%{http_code}' -X POST -H 'content-type: application/json' -H @- --data "$2" "$API_URL$1"; }
split() { CODE="${1##*$'\n'}"; BODY="${1%$'\n'*}"; }

# --- 4. dry-run quote + simulated settlement ----------------------------------
say "Gift: dry-run 1Click quote (no deposit address, nothing deposited)"
split "$(post /api/gifts/quote "$(printf '{"donor":"donor-demo-1","fund":"missions","originAsset":"%s","amount":"%s","refundTo":"0x000000000000000000000000000000000000dEaD","refundType":"ORIGIN_CHAIN","slippageTolerance":100}' "$ORIGIN_ASSET" "$GIFT_AMOUNT")")"
echo "    HTTP $CODE $BODY"
[[ "$CODE" == 2* ]] || die "quote failed"
GIFT_ID="$(jget id <<<"$BODY")"
QUOTE_MODE="$(jget quoteMode <<<"$BODY")"
DEPOSIT="$(jget depositAddress <<<"$BODY")"
[[ "$QUOTE_MODE" == "dry_run" ]] || die "API returned quoteMode=\"$QUOTE_MODE\", not dry_run. Stopping for safety."
[[ "$DEPOSIT" == sim:* ]] || die "deposit address \"$DEPOSIT\" is not a simulated sim: address. Stopping for safety."

say "Gift: simulated settlement on testnet (mints tUSDC into the treasury, credits the missions fund)"
split "$(post "/api/gifts/$GIFT_ID/simulate-settlement" '{}')"
echo "    HTTP $CODE $BODY"
[[ "$CODE" == 2* && "$(jget status <<<"$BODY")" == "settled" ]] || die "simulate-settlement did not settle the gift"
SETTLE_TX="$(jget settlementTxHash <<<"$BODY")"
echo "    settlement tx: ${SETTLE_TX:-"(none returned)"}"

# --- 5. bills ---------------------------------------------------------------
DEMO_FUND=missions # the demo gift's fund; both bills are paid from it
request_payout() { # billId amount memo expected
  split "$(post /api/payouts/request "$(printf '{"vendor":"%s","amount":"%s","billId":"%s","memo":"%s","fund":"%s"}' "$DEMO_VENDOR" "$2" "$1" "$3" "$DEMO_FUND")")"
  printf '    %s -> HTTP %s %s\n' "$1" "$CODE" "$BODY"
  if [[ "$CODE" != 2* ]]; then
    echo "    (rejected by the contract. If the vendor allowlist add is still inside the 24h"
    echo "     timelock, re-run scripts/demo.sh after it passes; setup.mjs executes it then."
    echo "     \"insufficient fund balance\" means the $DEMO_FUND fund has not received enough.)"
    return 1
  fi
  [[ "$(jget status <<<"$BODY")" == "$4" ]] || echo "    (expected status \"$4\")"
}

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
AUTO_BILL="demo-auto-$stamp"
HOLD_BILL="demo-hold-$stamp"
say "Bills to $DEMO_VENDOR from the $DEMO_FUND fund"
bills_ok=1
request_payout "$AUTO_BILL" "$SMALL" "Demo: routine allowlisted bill" paid || bills_ok=0
request_payout "$HOLD_BILL" "$LARGE" "Demo: unusual bill over per-bill limit" held || bills_ok=0
echo "    Held bills: $(curl -s "$API_URL/api/holds?status=held")"

# --- 5b. treasurer approves the unusual bill --------------------------------
approve_ok=0
if [[ $bills_ok -eq 1 ]]; then
  say "Treasurer approves the held bill $HOLD_BILL (owner / treasurer key, not the agent)"
  split "$(post_treasurer "/api/holds/$HOLD_BILL/approve" '{}')"
  echo "    HTTP $CODE $BODY"
  if [[ "$CODE" == 2* && "$(jget status <<<"$BODY")" == "approved" ]]; then
    approve_ok=1
  else
    echo "    (approve did not return status approved)"
  fi
fi

# --- 6. UI -------------------------------------------------------------------
if [[ $NO_UI -eq 0 ]]; then
  say "Starting treasurer page (log: tmp/demo-web.log)"
  ( cd "$ROOT/apps/web"
    [[ -d node_modules ]] || npm install --no-audit --no-fund
    OPENLID_API_URL="$API_URL" VITE_OPENLID_APPROVAL_SECRET="$APPROVAL_SECRET" exec npx vite --host 127.0.0.1 --port 5173 --strictPort
  ) >"$LOG_DIR/demo-web.log" 2>&1 &
  PIDS+=("$!")
  wait_for "http://127.0.0.1:5173/" 60 || { tail -n 30 "$LOG_DIR/demo-web.log" >&2; die "UI did not start"; }
  echo "    Open http://127.0.0.1:5173/  (if the API has no CORS: http://127.0.0.1:5173/?api=same-origin)"
fi

[[ $bills_ok -eq 1 ]] || echo "
NOTE: bills were not both accepted (see above). The gift leg ran; the payout leg did not complete."
if [[ $ONCE -eq 1 ]]; then
  say "Demo once-mode summary (testnet account ids and tx hashes only; no keys)"
  echo "    gift id: $GIFT_ID"
  echo "    deposit address: $DEPOSIT"
  echo "    quote mode: $QUOTE_MODE"
  echo "    settlement tx: ${SETTLE_TX:-none}"
  # Re-fetch the settled gift so we print the mint tx, not the last approve body.
  gift_json="$(curl -s "$API_URL/api/gifts/$GIFT_ID")"
  echo "    settled gift: $gift_json"
  echo "    auto bill: $AUTO_BILL"
  echo "    hold bill: $HOLD_BILL (approved=$approve_ok)"
  echo "    payouts: $(curl -s "$API_URL/api/payouts")"
  echo "    holds: $(curl -s "$API_URL/api/holds")"
  echo "    summary: $(curl -s "$API_URL/api/summary")"
  if [[ $bills_ok -eq 1 && $approve_ok -eq 1 ]]; then
    say "Demo steps completed. API will stop on exit."
    exit 0
  fi
  die "Demo ran but a payout or approve step did not succeed (see above)." 5
fi

say "Running on NEAR testnet. Ctrl-C to stop."
wait
