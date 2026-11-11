# OpenLid

Church stablecoin giving on NEAR. Hackathon build by Michael McClanahan (@tnvolman).

> Everything here is a demo. Receipts and exports are labeled **demo, not a tax document**.
> Testnet or a local sandbox only. Never put mainnet funds or real keys in this project.

## What it is

- **Giving.** A donor gives from another chain through [NEAR Intents 1Click](https://docs.near-intents.org). Each gift gets its own 1Click quote and its own deposit address, tagged with the donor and a fund (`general`, `missions`, or `building`). Deposit addresses are never reused, and incoming swaps are matched to gifts by deposit address only, never by amount.
- **Settlement.** The swap delivers USDC to a NEAR treasury contract on an account the church owns.
- **Payouts.** Rules live in the contract, not the agent. The contract enforces:
  - a vendor allowlist
  - a per-bill limit
  - a monthly cap
  - a 24-hour timelock on allowlist changes
- **Agent.** The agent has only a restricted function-call access key, and that key can call only `request_payout`. It cannot pay an unknown vendor, go over the cap, or skip a hold.
- **Holds.** A bill to an allowlisted vendor that is over the per-bill limit is held for the church treasurer. In real use the treasurer is a hardware wallet or a multisig. The treasurer approves or rejects the bill.

## Repository layout

| Path | What |
| --- | --- |
| `contracts/treasury` | Rust `near-sdk` treasury contract (allowlist, limits, holds, timelock) |
| `apps/api` | HTTP API on `127.0.0.1:8787`: 1Click quotes and status sync, payout requests, holds, summary, CSV export |
| `apps/web` | Treasurer page (Vite + vanilla TypeScript) on `127.0.0.1:5173` |
| `scripts/demo.sh` | Local demo runner and seeder |
| `INTERFACES.md` | The contract, API, and UI contract all parts build against |

The contract, API, and UI are built in separate worktrees and merged at integration. Some of these directories may not exist yet on a given branch. See [Known issues](#known-issues).

## Setup

Toolchain:

- Node 22 (22.18 or newer; the web tests use Node's built-in TypeScript stripping)
- Rust (stable) with the wasm target: `rustup target add wasm32-unknown-unknown`
- `curl`, plus `bash` for the demo script

Config:

```bash
cp .env.example .env    # .env is gitignored. Fill it in locally.
```

- Set `OPENLID_NETWORK=testnet`, or use a local sandbox. **No mainnet.** `scripts/demo.sh` refuses to run if the network is `mainnet`.
- Never put keys in git. `OPENLID_AGENT_KEY_FILE` and the optional `OPENLID_OWNER_KEY_FILE` are paths to key files on your own machine, outside the repo. The agent key must be a function-call key limited to `request_payout` on the treasury contract. Do not commit a seed phrase, private key, or full-access key, and do not paste one into logs or fixtures. CI runs gitleaks.
- `ONECLICK_API_KEY` goes only in your private `.env`.

## Architecture

### Gift flow

```
donor ──► POST /api/gifts/quote {donor, fund, originAsset, amount, refundTo, …}
            │  API calls 1Click POST /v0/quote (dry:false, EXACT_INPUT,
            │  ORIGIN_CHAIN deposit, recipient = church treasury contract)
            ▼
          one gift persisted, keyed by quote.depositAddress (unique per gift)
            │
donor sends funds on the origin chain to that deposit address
            │
            ▼
          POST /api/gifts/:id/sync  → 1Click GET /v0/status?depositAddress=…
            │  PENDING_DEPOSIT                          → pending_deposit
            │  KNOWN_DEPOSIT_TX / PROCESSING / INCOMPLETE_DEPOSIT → processing
            │  SUCCESS → settled   REFUNDED → refunded   FAILED → failed
            ▼
          settled = USDC landed in the church-owned treasury contract
```

### Payout request flow

1. The treasurer or a bookkeeping helper submits a bill to `POST /api/payouts/request` with `vendor`, `amount`, a unique `billId`, and `memo`.
2. The API calls `request_payout` on the treasury contract, signing with the agent's restricted function-call key only.
3. The contract checks the caller, the allowlist, that `bill_id` is unique, the per-bill limit, and the monthly cap.
4. If the vendor is allowlisted, the amount is at or under the per-bill limit, and the cap has room, the contract sends USDC to the vendor. Status: `paid`.
5. If the vendor is allowlisted, the amount is over the per-bill limit, and the cap has room, nothing is sent and a hold is created. The treasurer later calls `approve_hold` or `reject_hold` with the owner key (`POST /api/holds/:billId/approve|reject` in the demo). Approval checks the cap again.
6. Anything else is rejected on-chain.

Allowlist changes go through `propose_allowlist_change`, which only the owner can call. They take effect only when `execute_allowlist_change` is called at least 24 hours later.

### Treasurer page (`apps/web`)

- Summary, from `GET /api/summary`.
- Outstanding holds, from `GET /api/holds?status=held`, each with **Approve** and **Reject** buttons.
- Payouts, from `GET /api/payouts`.
- Gifts grouped by fund, from `GET /api/gifts`. Every status is shown, including `refunded` and `failed`.
- A **Download CSV** button that opens `GET /api/export.csv`.
- The visible label **demo, not a tax document**.

The API base is `http://127.0.0.1:8787` by default. To change it:

- Add `?api=http://host:port` to the page URL, or set `VITE_OPENLID_API_BASE` at dev or build time.
- Use `?api=same-origin` to send requests through the Vite dev proxy instead. The proxy target is `OPENLID_API_URL`.
- Use `?mock=1` to show the built-in fixture with no API.

## Running

```bash
# UI only, fixture data
cd apps/web && npm install && npm run dev
# open http://127.0.0.1:5173/?mock=1

# Full local demo: starts apps/api if present, seeds bills, starts the UI
scripts/demo.sh            # or --seed-only / --no-ui; see the header of the script
```

`scripts/demo.sh` sends two bills through `POST /api/payouts/request`:

- a small bill to an allowlisted vendor, which should be **paid** automatically
- an unusual bill over the per-bill limit, which should be **held** until the treasurer acts in the UI

To match your contract config, set:

- `DEMO_VENDOR`, which must already be allowlisted
- `DEMO_SMALL_AMOUNT` and `DEMO_LARGE_AMOUNT`, in USDC atomic units with 6 decimals

The script never sources `.env` and never reads key files. It does not create gifts.

### Seeding a gift

`POST /api/gifts/quote` calls the real 1Click API and returns a real deposit address. Request one only on testnet and only when you mean to. Example body, using the shape from `INTERFACES.md`:

```bash
curl -X POST http://127.0.0.1:8787/api/gifts/quote -H 'content-type: application/json' -d '{
  "donor": "Demo Donor", "fund": "missions", "originAsset": "<1Click asset id>",
  "amount": "<atomic units>", "refundTo": "<your origin-chain address>",
  "refundType": "ORIGIN_CHAIN", "slippageTolerance": 100 }'
```

## Tests

```bash
# Contract
cd contracts/treasury && cargo test

# API (1Click is mocked)
cd apps/api && npm install && npm test

# Treasurer page (node:test, no browser, no live API)
cd apps/web && npm install && npm test
cd apps/web && npm run typecheck && npm run build
```

The web tests use the in-memory fixture. They check:

- grouping by fund, with refunded and failed gifts kept
- that approve and reject call `POST /api/holds/:billId/approve|reject`
- that the CSV button points at `/api/export.csv`
- that the exact receipt label appears on the page

## Known issues

- **Mainnet is out of scope.** A live mainnet demo transfer happens only after an explicit yes on a funded wallet. Nothing in this repo sends mainnet transactions.
- **1Click is mocked in tests.** No test calls the real 1Click service. The demo script does not create gifts. It only documents how.
- **NEAR sandbox may be missing.** The `near-workspaces` sandbox may not be in this tree yet. Contract coverage is `near-sdk` unit tests. If the sandbox cannot run, the API's demo contract state may be mocked. `apps/api` documents which mode it is in.
- **The API comes from another branch.** On the `openlid/ui` branch, `apps/api` and `contracts/` come from other worktrees. `scripts/demo.sh` prints a clear message and falls back to the UI in mock mode when the API is missing. The `npm test` command for the API assumes the API package defines a `test` script.
- **CORS.** The page calls the API cross-origin, from `:5173` to `:8787`. If the API does not send CORS headers, use `?api=same-origin`, which goes through the Vite proxy.
- **CSV download.** The download goes to the API's URL. Whether the browser saves the file or shows it depends on the API's `Content-Disposition` header.
- **No authentication on the treasurer page.** In the demo, the API holds the owner key path. In real use, approve and reject would be signed by the treasurer's hardware wallet or multisig, not by the server.

## How OpenLid differs from POTLOCK

This comparison uses only POTLOCK's public docs at <https://docs.potlock.io>.

**POTLOCK** is an open funding platform for public-goods projects:

- Donors can give NEAR directly to a project, or give during a Pot matching round.
- In a Pot, sponsors fund a matching pool, and verified donors support approved projects. When the round ends, quadratic funding splits the matching pool based on broad unique support.
- Direct donations go to the project. Matched payouts happen after the calculation and a cooldown period.
- The docs also describe a cross-chain QR donate path that settles in NEAR.

**OpenLid** is not a public-goods matching round. It is one church's treasury:

- Gifts are designated to the church's own funds (`general`, `missions`, `building`).
- Gifts settle as USDC to an account the church owns.
- Money goes out only as vendor payouts. The contract enforces the vendor allowlist (with a 24-hour timelock on changes), a per-bill limit, and a monthly cap. Unusual bills are held for the treasurer.
- There is no matching pool and no quadratic funding.

## Credit

OpenLid by Michael McClanahan (@tnvolman).
