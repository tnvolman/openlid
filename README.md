# OpenLid

**Unaudited. Testnet only. Not for real funds. Provided as-is.**

Church stablecoin giving on NEAR. Hackathon build by Michael McClanahan (@tnvolman).

> **NEAR testnet only. $0 spend.** The cross-chain leg is a dry-run 1Click quote plus a simulated settlement on NEAR testnet. There are no mainnet accounts, no real funds, and no paid APIs, and no deposit is ever sent.
> Receipts and exports are labeled **demo, not a tax document**. Never put mainnet funds or real keys in this project.

## What it is

- **Giving (design).** A donor gives from another chain through [NEAR Intents 1Click](https://docs.near-intents.org). Each gift gets its own 1Click quote and its own deposit address, tagged with the donor and a fund (`general`, `missions`, or `building`). Deposit addresses are never reused, and gifts are matched by deposit address only, never by amount.
- **Giving (this demo).** 1Click is mainnet-only, so the demo asks for **dry-run** quotes only (`dry: true`):
  - A dry quote has no deposit address, so the API gives each gift a unique simulated address (`sim:<id>`) and still matches gifts by that address only.
  - With `ONECLICK_API_KEY` unset, the API uses a local stub that returns responses shaped like dry-run quotes, so it never calls the paid live endpoint.
  - No deposit is ever sent.
- **Settlement (this demo).** The cross-chain transfer is simulated. `POST /api/gifts/:id/simulate-settlement` mints a test token (`tUSDC`, a minimal NEP-141 with 6 decimals) into the church's treasury contract on NEAR testnet, then marks the gift `settled`. In the full design, the 1Click swap would deliver real USDC instead.
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
| `contracts/test-ft` | Minimal NEP-141 `tUSDC` test token, testnet and unit tests only |
| `apps/api` | HTTP API on `127.0.0.1:8787`: dry-run 1Click quotes, simulated settlement, payout requests, holds, summary, CSV export |
| `apps/web` | Treasurer page (Vite + vanilla TypeScript) on `127.0.0.1:5173` |
| `scripts/demo.sh` | Testnet demo runner |
| `scripts/testnet/setup.mjs` | Creates testnet accounts through the faucet, generates keys into `.demo-keys/`, and deploys the contracts |
| `INTERFACES.md` | The contract, API, and UI contract all parts build against |

The contract, API, and UI are built in separate worktrees and merged at integration. See [Known issues](#known-issues).

## Setup

Toolchain:

- Node 22 (22.18 or newer; the web tests use Node's built-in TypeScript stripping)
- Rust (stable) with the wasm target: `rustup target add wasm32-unknown-unknown`
- `curl`, `git`, and `bash` for the demo script
- Internet access to `rpc.testnet.near.org` and the free testnet faucet

Config:

```bash
cp .env.example .env    # .env is gitignored. Fill it in locally.
```

- `OPENLID_NETWORK=testnet`. **No mainnet.** `scripts/demo.sh` and `scripts/testnet/setup.mjs` refuse to run on any other network. `setup.mjs` also checks that the RPC reports `chain_id` `testnet`.
- Leave `ONECLICK_API_KEY` empty. The $0 demo must not call the paid live 1Click API. `scripts/demo.sh` removes this variable from the API's environment even if it is set.
- Never put keys in git. The demo generates testnet keys at run time into `.demo-keys/` (set by `OPENLID_DEMO_KEYS_DIR`; gitignored; directory mode 0700, files 0600). Key material is never printed. Logs show only account ids, file paths, and transaction links.
- `OPENLID_AGENT_KEY_FILE` and `OPENLID_OWNER_KEY_FILE` are paths to key files, not keys. The agent key is a function-call key limited to `request_payout` on the treasury contract. Do not commit a seed phrase, private key, or full-access key, and do not paste one into logs or fixtures. CI runs gitleaks.

## Architecture

### Gift flow

```
donor ──► POST /api/gifts/quote {donor, fund, originAsset, amount, refundTo, …}
            │  dry-run quote: 1Click POST /v0/quote with dry:true (only if
            │  ONECLICK_API_KEY is set), otherwise a local stub with the same
            │  dry-run shape. Response has quoteMode: "dry_run".
            ▼
          one gift persisted, keyed by a unique deposit address:
          quote.depositAddress if present, else simulated "sim:<id>"
            │
            │  (demo) no deposit is sent on any chain
            ▼
          POST /api/gifts/:id/simulate-settlement   (testnet only)
            │  mints tUSDC into the church's treasury contract on testnet
            ▼
          settled = test FT credited to the church-owned treasury contract

          Real 1Click status mapping (covered by mocked tests; the demo
          does not use it for sim: addresses):
          POST /api/gifts/:id/sync  → GET /v0/status?depositAddress=…
            PENDING_DEPOSIT → pending_deposit
            KNOWN_DEPOSIT_TX / PROCESSING / INCOMPLETE_DEPOSIT → processing
            SUCCESS → settled   REFUNDED → refunded   FAILED → failed
```

### Payout request flow

1. The treasurer or a bookkeeping helper submits a bill to `POST /api/payouts/request` with `vendor`, `amount`, a unique `billId`, and `memo`.
2. The API calls `request_payout` on the treasury contract, signing with the agent's restricted function-call key only.
3. The contract checks the caller, the allowlist, that `bill_id` is unique, the per-bill limit, and the monthly cap.
4. If the vendor is allowlisted, the amount is at or under the per-bill limit, and the cap has room, the contract transfers the token to the vendor. Status: `paid`.
5. If the vendor is allowlisted, the amount is over the per-bill limit, and the cap has room, nothing is sent and a hold is created. The treasurer later calls `approve_hold` or `reject_hold` with the owner key (`POST /api/holds/:billId/approve|reject` in the demo). Approval checks the cap again.
6. Anything else is rejected on-chain.

Allowlist changes go through `propose_allowlist_change`, which only the owner can call. They take effect only when `execute_allowlist_change` is called at least 24 hours later.

### Treasurer page (`apps/web`)

- The notice: NEAR testnet only, dry-run quote plus simulated settlement.
- Summary, from `GET /api/summary`.
- Outstanding holds, from `GET /api/holds?status=held`, each with **Approve** and **Reject** buttons.
- Payouts, from `GET /api/payouts`.
- Gifts grouped by fund, from `GET /api/gifts`. Every status is shown, including `refunded` and `failed`. Simulated `sim:` deposit addresses are tagged **simulated**.
- A **Download CSV** button that opens `GET /api/export.csv`.
- The visible label **demo, not a tax document**.

The API base is `http://127.0.0.1:8787` by default. To change it:

- Add `?api=http://host:port` to the page URL, or set `VITE_OPENLID_API_BASE` at dev or build time.
- Use `?api=same-origin` to send requests through the Vite dev proxy instead. The proxy target is `OPENLID_API_URL`.
- Use `?mock=1` to show the built-in fixture with no API. The fixture uses dry-run gifts with `sim:` addresses.

## Running the testnet demo

```bash
scripts/demo.sh            # full run
scripts/demo.sh --no-ui    # skip the UI
```

What `scripts/demo.sh` does, in order:

1. Prints the notice: NEAR testnet only, $0 spend, and the cross-chain leg is a dry-run 1Click quote plus a simulated settlement on testnet.
2. Refuses to run unless the network is `testnet`.
3. Runs `scripts/testnet/setup.mjs`:
   - Creates a `openlid-demo-<id>.testnet` account through the free testnet faucet. This account plays the church owner and treasurer.
   - Creates the sub-accounts `agent.*`, `vendor.*`, `treasury.*`, and `tusdc.*`, funded only with testnet NEAR from the faucet.
   - Writes keys only to `.demo-keys/`, and reuses the accounts on later runs.
   - Deploys and initializes `contracts/test-ft` and `contracts/treasury`. Defaults: per-bill limit 100 tUSDC, monthly cap 10,000 tUSDC.
   - Replaces the agent's bootstrap key with a single function-call key for `request_payout`.
   - Proposes adding the vendor to the allowlist.
   - Writes `.demo-keys/demo.env`, which holds account ids and key-file paths only.
4. Starts `apps/api` with that config, `ONECLICK_API_KEY` unset, and `ONECLICK_DRY_RUN=true`.
5. Asks for one dry-run gift quote. It stops unless the response has `quoteMode: "dry_run"` and a `sim:` address.
6. Calls `POST /api/gifts/:id/simulate-settlement`, which mints tUSDC into the treasury.
7. Sends two bills through `POST /api/payouts/request`:
   - 50 tUSDC, which should be **paid**
   - 500 tUSDC, which should be **held** for the treasurer
8. Starts the treasurer page on <http://127.0.0.1:5173>.

If the faucet or the contract deploy cannot run, the script stops and says so. It does not fake a testnet receipt.

The page alone, with fixture data:

```bash
cd apps/web && npm install && npm run dev
# open http://127.0.0.1:5173/?mock=1
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
- that fixture gifts are dry-run quotes with unique `sim:` addresses, tagged **simulated** on the page
- that approve and reject call `POST /api/holds/:billId/approve|reject`
- that the CSV button points at `/api/export.csv`
- that the receipt label and the testnet notice appear on the page

## Known issues

- **The cross-chain leg is not real.** 1Click is mainnet-only, so the demo uses dry-run quotes (no deposit address) and a simulated settlement that mints a test token on testnet. No real cross-chain deposit happens. A live mainnet transfer would need an explicit yes on a funded wallet, and that is out of scope for this demo.
- **1Click is mocked in tests.** No test calls the real 1Click service. Without `ONECLICK_API_KEY`, the API uses a local dry-run stub.
- **Wasm filenames.** After `cargo build --target wasm32-unknown-unknown --release`, setup looks for `contracts/treasury/target/wasm32-unknown-unknown/release/openlid_treasury.wasm` and `contracts/test-ft/target/wasm32-unknown-unknown/release/openlid_test_ft.wasm` (and the `target/near/` equivalents). Build those before `scripts/demo.sh`.
- **24-hour allowlist timelock.** Later allowlist add or remove still waits 24 hours. A fresh deploy may pass an `initial_allowlist` to `new`; those vendors are active immediately, as deploy-time configuration rather than a later change. The demo uses that so the first run can pay and hold bills on the same day.
- **Test-FT init.** The test FT is initialized with `new({ owner })`, matching `contracts/test-ft`. Override with `DEMO_FT_INIT_METHOD` and `DEMO_FT_INIT_ARGS` only if you swap the token. If the token has no `storage_deposit`, that step is skipped with a note.
- **The faucet may limit requests.** The testnet faucet can rate-limit or change its endpoint. Override the endpoint with `NEAR_TESTNET_FAUCET`. The created account is reused through `.demo-keys/state.json`.
- **Assumed API test script.** The `npm test` command for the API assumes the API package defines a `test` script.
- **NEAR sandbox.** `near-workspaces` sandbox tests may not be in this tree. Contract coverage is `near-sdk` unit tests.
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
- Gifts settle to an account the church owns. In this demo, that settlement is a simulated tUSDC mint on testnet.
- Money goes out only as vendor payouts. The contract enforces the vendor allowlist (with a 24-hour timelock on changes), a per-bill limit, and a monthly cap. Unusual bills are held for the treasurer.
- There is no matching pool and no quadratic funding.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

The OpenLid name and logo are not licensed under Apache-2.0. See [TRADEMARK.md](TRADEMARK.md).

To report a vulnerability, use GitHub private vulnerability reporting (the repo Security tab, **Report a vulnerability**). See [SECURITY.md](SECURITY.md).

## Credit

OpenLid by Michael McClanahan (@tnvolman).
