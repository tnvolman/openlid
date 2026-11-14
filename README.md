# OpenLid

**Unaudited. Testnet only. Not for real funds. Provided as-is.**

Church stablecoin giving on NEAR. Hackathon build by Michael McClanahan (@tnvolman).

> **NEAR testnet only. $0 spend.** The cross-chain leg is a dry-run 1Click quote plus a simulated settlement on NEAR testnet. There are no mainnet accounts, no real funds, and no paid APIs, and no deposit is ever sent.
> Receipts and exports are labeled **demo, not a tax document**. Never put mainnet funds or real keys in this project.

The author also entered Onhire, an independent project, in this hackathon: https://github.com/tnvolman/onhire

## What it is

- **Giving (design).** A donor gives from another chain through [NEAR Intents 1Click](https://docs.near-intents.org). Each gift gets its own 1Click quote and its own deposit address, tagged with the donor and a fund (`general`, `missions`, or `building`). Deposit addresses are never reused, and gifts are matched by deposit address only, never by amount.
- **Giving (this demo).** 1Click is mainnet-only, so the demo asks for **dry-run** quotes only (`dry: true`):
  - A dry quote has no deposit address, so the API gives each gift a unique simulated address (`sim:<id>`) and still matches gifts by that address only.
  - With `ONECLICK_API_KEY` unset, the API uses a local stub that returns responses shaped like dry-run quotes, so it never calls the paid live endpoint.
  - No deposit is ever sent.
- **Settlement (this demo).** The cross-chain transfer is simulated. `POST /api/gifts/:id/simulate-settlement` mints a test token (`tUSDC`, a minimal NEP-141 with 6 decimals) into the church's treasury contract on NEAR testnet, then the owner records it in the gift's fund on-chain (`credit_fund`), then marks the gift `settled`. If the fund credit fails, the gift is not marked settled. In the full design, the 1Click swap would deliver real USDC instead.
- **Payouts.** Rules live in the contract, not the agent. In this demo the treasury account also keeps a full-access key that could bypass the contract (see [Known issues](#known-issues)). The contract enforces:
  - a vendor allowlist
  - a per-bill limit
  - a monthly cap
  - a 24-hour timelock on allowlist changes
  - per-fund balances: every bill names a fund (`general`, `missions`, or `building`) and is paid only if that fund's uncommitted `available = received - paid - held` covers it. Outstanding holds reserve their amount, so two holds cannot commit the same money. A building bill can spend only what the building ledger shows as available. Ledger credits are owner-entered and not checked against tokens received (see [Known issues](#known-issues)), so the cash-vs-ledger line is what catches a wrong credit.
  - The per-fund ledger is unit-tested (`cargo test`) and deployed on NEAR testnet at `treasury.openlid-demo-mwfrrslq.testnet`. There, the contract refused a 50 tUSDC `building` bill while the building ledger had 0 available, and paid a `missions` bill. See [contracts/treasury/TESTNET-PROOF.md](contracts/treasury/TESTNET-PROOF.md) for the transaction links. The older testnet treasury `treasury.openlid-demo-mwbp9t7m.testnet` runs the earlier build, without per-fund balances.
- **Fund labels.** In current US GAAP wording, `missions` and `building` are **with donor restrictions** and `general` is **without donor restrictions**. That is a label, not a permission: all three funds are siloed, and `general` cannot pay a missions or building bill. Doing that on purpose would be an interfund transfer, which is not built (see [Does not cover](#does-not-cover-yet)). There are no board-designated set-asides, and nothing is called "restricted" that the donor did not restrict.
- **Agent.** The agent has only a restricted function-call access key, and that key can call only `request_payout`. On-chain it cannot pay an unknown vendor, go over the cap, skip a hold, or pay a bill beyond its own fund's ledger balance. Approving a hold is an owner-only contract method the agent's key cannot call. In the local API, approving or rejecting a hold also needs the treasurer's approval secret (`X-OpenLid-Approval`). The agent's endpoint, `POST /api/payouts/request`, does not take the secret, and the agent is not handed it. But any program on the same machine can read it if it can read the page bundle (Vite inlines `VITE_OPENLID_APPROVAL_SECRET`), `.demo-keys/approval.env`, or the API's environment. So it is a demo control, not a boundary. The demo has no separate agent process: `scripts/demo.sh` sends both the bills and the treasurer's approval. The API is meant to run on `127.0.0.1` only (see [Known issues](#known-issues)).
- **Holds.** A bill to an allowlisted vendor that is over the per-bill limit is held for the church treasurer. In real use the treasurer is a hardware wallet or a multisig. The treasurer approves or rejects the bill. The hold only looks at one bill at a time; see [Known issues](#known-issues) for split bills.

## Repository layout

| Path | What |
| --- | --- |
| `contracts/treasury` | Rust `near-sdk` treasury contract (allowlist, limits, holds, timelock, per-fund ledger); testnet proof in `TESTNET-PROOF.md` |
| `contracts/test-ft` | Minimal NEP-141 `tUSDC` test token, testnet and unit tests only |
| `apps/api` | HTTP API on `127.0.0.1:8787`: dry-run 1Click quotes, simulated settlement, payout requests, holds, summary, CSV export |
| `apps/web` | Treasurer page (Vite + vanilla TypeScript) on `127.0.0.1:5173` |
| `scripts/demo.sh` | Testnet demo runner |
| `scripts/testnet/setup.mjs` | Creates testnet accounts through the faucet, generates keys into `.demo-keys/`, and deploys the contracts |
| `scripts/testnet/prove-fund-refusal.mjs` | Testnet proof after setup: credits `missions`, shows a `building` bill refused for insufficient fund balance, pays a `missions` bill |
| `INTERFACES.md` | The contract, API, and UI contract all parts build against |

## Setup

Toolchain:

- Node 22 (22.18 or newer; the web tests use Node's built-in TypeScript stripping)
- Rust (stable) with the wasm target: `rustup target add wasm32-unknown-unknown`
- `curl`, `git`, and `bash` for the demo script
- Internet access to a NEAR testnet RPC and the free testnet faucet. The API defaults to `https://rpc.testnet.fastnear.com`; override with `OPENLID_NEAR_RPC_URL`. The official `rpc.testnet.near.org` is deprecated and currently answers HTTP 429. `scripts/testnet/setup.mjs` uses the same `OPENLID_NEAR_RPC_URL` and FastNear default (`NEAR_TESTNET_RPC` is still accepted as a fallback).

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
            │  1. mints tUSDC into the church's treasury contract on testnet
            │  2. owner signs credit_fund(gift.fund, amount, gift.id):
            │     that fund's on-chain `received` grows (ledger only)
            ▼
          settled = test FT credited to the church-owned treasury contract
                    and recorded in the gift's fund

          Real 1Click status mapping (covered by mocked tests; the demo
          does not use it for sim: addresses):
          POST /api/gifts/:id/sync  → GET /v0/status?depositAddress=…
            PENDING_DEPOSIT → pending_deposit
            KNOWN_DEPOSIT_TX / PROCESSING / INCOMPLETE_DEPOSIT → processing
            SUCCESS → settled   REFUNDED → refunded   FAILED → failed
```

### Payout request flow

1. The treasurer or a bookkeeping helper submits a bill to `POST /api/payouts/request` with `vendor`, `amount`, a unique `billId`, `memo`, and `fund` (`general`, `missions`, or `building`; anything else is a `400`).
2. The API calls `request_payout` on the treasury contract, signing with the agent's restricted function-call key only.
3. The contract checks the caller, the fund, the allowlist, that `bill_id` is unique, the per-bill limit, the monthly cap, and that the bill fits the fund's available balance.
4. If the vendor is allowlisted, the amount is at or under the per-bill limit, the cap has room, and the fund covers it, the contract transfers the token to the vendor and adds the amount to the fund's `paid`. Status: `paid`.
5. If the vendor is allowlisted, the amount is over the per-bill limit, the cap has room, and the fund covers it, nothing is sent and a hold is created. The treasurer later calls `approve_hold` or `reject_hold` with the owner key (`POST /api/holds/:billId/approve|reject` in the demo). Approval checks the cap, the allowlist, and the fund balance again, since another bill may have used the fund in the meantime.
6. Anything else is rejected on-chain, for example `insufficient fund balance: building has 0 available, bill needs 50000000`. The API returns it as `422 { "error": ... }` and the page shows it in USDC.

A hold reserves its amount from the moment it is created: `available` drops, a second hold or routine bill that would need the same money is refused straight away, approval moves the amount from held to paid, and rejection releases it.

Allowlist changes go through `propose_allowlist_change`, which only the owner can call. They take effect only when `execute_allowlist_change` is called at least 24 hours later.

### Treasurer page (`apps/web`)

- The notice: NEAR testnet only, dry-run quote plus simulated settlement.
- Six boundary lines, always visible: not an IRS Publication 1771 acknowledgment or giving statement; not GAAP financial statements or an audit, review, or compilation (testnet only, no real funds); approve/reject is checked only by a shared approval secret in this demo (not wallet signing) and the server signs as owner; the demo covers fund-tagged gifts and bills, not interfund transfers, budgets, pledges, or tax receipts; USDC and other digital-asset gifts are noncash property and every amount is **book value at receipt** (church books only), not a deductible value, with no FMV acknowledgment and Forms 8283/8282 and appraisals out of scope (a CPA must confirm current rules); OpenLid never holds or moves donor funds for someone else, gifts go to a treasury the church controls, and a legal review is required before any real money.
- Every amount table is captioned "book value at receipt (church books only), not a deductible value".
- Summary, from `GET /api/summary`: the live on-chain treasury balance next to the **sum of fund ledgers** (received − paid), with a visible **match / mismatch** flag; then a table per fund with **Restriction**, **Gifts** (settled count), **Received**, **Paid out**, **Held**, and **Available** (uncommitted: received − paid out − held).
- Outstanding holds, from `GET /api/holds?status=held`, with **Fund**, **Requested** time, the request tx reference, and **Approve** / **Reject** buttons.
- Payouts, from `GET /api/payouts`, with **Fund**, **Requested** and **Paid** times, and the **Payment ref** (tx hash).
- Gifts grouped by fund, from `GET /api/gifts`. Every status is shown, including `refunded` and `failed`. Simulated `sim:` deposit addresses are tagged **simulated**.
- A **Download CSV** button that opens `GET /api/export.csv`: a reconciliation export with the receipt, Pub 1771, and not-GAAP lines at the top, `fund` and restriction on every gift and bill row, dates and tx references, and a per-fund reconciliation section (received, paid, held, available) plus the cash-vs-ledgers line.
- The visible label **demo, not a tax document**.

The API base is `http://127.0.0.1:8787` by default. To change it:

- Add `?api=http://host:port` to the page URL, or set `VITE_OPENLID_API_BASE` at dev or build time.
- Use `?api=same-origin` to send requests through the Vite dev proxy instead. The proxy target is `OPENLID_API_URL`.
- Use `?mock=1` to show the built-in fixture with no API. The fixture uses dry-run gifts with `sim:` addresses.
- Set `VITE_OPENLID_APPROVAL_SECRET` to the API's `OPENLID_APPROVAL_SECRET` so the Approve and Reject buttons send it as `X-OpenLid-Approval`. No other request sends it. If it is unset, approve and reject show the API's error (`401` or `503`) on the page.

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
4. Creates a random treasurer approval secret in `.demo-keys/approval.env` (mode 600, gitignored) if there is none yet. It is kept out of `demo.env` and never printed. Delete the file to rotate it.
5. Starts `apps/api` with that config plus `OPENLID_APPROVAL_SECRET`, `ONECLICK_API_KEY` unset, and `ONECLICK_DRY_RUN=true`.
6. Asks for one dry-run gift quote. It stops unless the response has `quoteMode: "dry_run"` and a `sim:` address.
7. Calls `POST /api/gifts/:id/simulate-settlement`, which mints 600 tUSDC into the treasury and credits it to the **missions** fund (`credit_fund`).
8. Sends two bills through `POST /api/payouts/request`, both with `"fund":"missions"` (50 + 500 = 550, covered by the 600 tUSDC gift):
   - 50 tUSDC, which should be **paid**
   - 500 tUSDC, which should be **held** for the treasurer
9. With `--once`, approves the held bill as the treasurer, sending `X-OpenLid-Approval`.
10. Otherwise starts the treasurer page on <http://127.0.0.1:5173> with `VITE_OPENLID_APPROVAL_SECRET` set, so its Approve and Reject buttons work.

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
- that approve and reject call `POST /api/holds/:billId/approve|reject`, and that only those two calls send `X-OpenLid-Approval`
- the per-fund summary table (Restriction, Gifts, Received, Paid out, Held, Available), restriction wording that never says general can pay any bill, the cash-vs-ledger match and mismatch flag, fund / date / reference columns on payouts and holds, and a clear message when a fund cannot cover an approval
- the six boundary lines on the page (including noncash property / book value at receipt, not a deductible value, and no custody / legal review before real money), the book-value caption on every amount table, no "tax deduction" wording, and the matching lines in the CSV header
- that the CSV button points at `/api/export.csv`
- that the receipt label and the testnet notice appear on the page

## Known issues

- **The cross-chain leg is not real.** 1Click is mainnet-only, so the demo uses dry-run quotes (no deposit address) and a simulated settlement that mints a test token on testnet. No real cross-chain deposit happens. A live mainnet transfer would need an explicit yes on a funded wallet, and that is out of scope for this demo.
- **1Click is mocked in tests.** No test calls the real 1Click service. Without `ONECLICK_API_KEY`, the API uses a local dry-run stub.
- **Wasm filenames.** After `cargo build --target wasm32-unknown-unknown --release`, setup looks for `contracts/treasury/target/wasm32-unknown-unknown/release/openlid_treasury.wasm` and `contracts/test-ft/target/wasm32-unknown-unknown/release/openlid_test_ft.wasm` (and the `target/near/` equivalents). Build those before `scripts/demo.sh`.
- **24-hour allowlist timelock.** Later allowlist add or remove still waits 24 hours. A fresh deploy may pass an `initial_allowlist` to `new`; those vendors are active immediately, as deploy-time configuration rather than a later change. The demo uses that so the first run can pay and hold bills on the same day.
- **Test-FT init.** The test FT is initialized with `new({ owner })`, matching `contracts/test-ft`. Override with `DEMO_FT_INIT_METHOD` and `DEMO_FT_INIT_ARGS` only if you swap the token. If the token has no `storage_deposit`, that step is skipped with a note.
- **Per-fund ledger is a breaking contract change.** The treasury's stored state and its `request_payout` arguments changed, and there is no migration. The existing testnet treasury `treasury.openlid-demo-mwbp9t7m.testnet` cannot be upgraded in place; run the demo against a fresh account (for example `OPENLID_DEMO_KEYS_DIR=.demo-keys/fund-ledger scripts/demo.sh --once` after rebuilding both wasm files). See INTERFACES.md, "Breaking change: per-fund ledger". `treasury.openlid-demo-mwbp9t7m.testnet` still runs the earlier build, without per-fund balances. The per-fund build is deployed on a fresh account, `treasury.openlid-demo-mwfrrslq.testnet`; see [contracts/treasury/TESTNET-PROOF.md](contracts/treasury/TESTNET-PROOF.md).
- **Noncash gifts, not tax values.** Stablecoin gifts are noncash property. Amounts on the page and in the CSV are book value at receipt for the church's books, never a deductible value. OpenLid does not issue noncash acknowledgments, state fair market value, or handle Forms 8283/8282 or appraisals. A CPA must confirm current rules.
- **No custody; legal review before real money.** OpenLid never holds or moves donor funds for someone else; gifts settle to a treasury contract the church controls. The intended 1Click path receives each gift at a per-gift deposit address before settling to the church treasury, and that path needs a legal review before mainnet or any real funds. The demo is testnet only and never sends a deposit.
- **Cash vs fund ledgers.** If the treasury's live token balance differs from the sum of fund ledgers (for example, tokens left over from an earlier demo run on the same account, or a mint whose `credit_fund` failed), the page shows a red **Mismatch** line with the difference. Use a fresh demo account to start matched.
- **Both settlement paths credit the fund.** `simulate-settlement` and a real 1Click `SUCCESS` seen by `/api/gifts/:id/sync` share one path: mint tUSDC (testnet only, once per gift), then `credit_fund`. The gift is `settled` only if both succeed. A re-sync of a settled gift does nothing, and a retry after a failed credit credits only.
- **`credit_fund` does not check the amount.** The owner-supplied amount is not verified against the tokens minted or received. Only the always-visible cash-vs-ledger line on the summary would catch a wrong amount.
- **The faucet may limit requests.** The testnet faucet can rate-limit or change its endpoint. Override the endpoint with `NEAR_TESTNET_FAUCET`. The created account is reused through `.demo-keys/state.json`.
- **NEAR sandbox.** There are no `near-workspaces` sandbox tests. Contract coverage is `near-sdk` unit tests, plus the testnet proof in [contracts/treasury/TESTNET-PROOF.md](contracts/treasury/TESTNET-PROOF.md). Nothing has been tested end to end in a sandbox.
- **CORS.** The page calls the API cross-origin, from `:5173` to `:8787`. If the API does not send CORS headers, use `?api=same-origin`, which goes through the Vite proxy.
- **CSV download.** The download goes to the API's URL. Whether the browser saves the file or shows it depends on the API's `Content-Disposition` header.
- **The treasurer approval secret is a demo control, not real authentication.** Approve and reject require an `X-OpenLid-Approval` header that matches `OPENLID_APPROVAL_SECRET`. If that variable is unset, they return `503`; a missing or wrong header gets `401`. The treasurer page sends the header from `VITE_OPENLID_APPROVAL_SECRET`, so the value lives in the page's local build, and anything that can read that build or its env can read it. In the demo the API also holds the owner key path. In real use, approve and reject are signed by the treasurer's hardware wallet or multisig, not by the server.
- **Only approve and reject check the approval secret.** The gift quote, `simulate-settlement`, `sync`, and `POST /api/payouts/request` routes are unauthenticated. Settlement makes the API sign the test-FT `mint` and `credit_fund` as the owner. So any local client can add test money to any fund in the demo, and then request payouts against it.
- **The treasury account keeps a full-access key in this demo.** `scripts/testnet/setup.mjs` creates the treasury account with a full-access key and keeps it in `.demo-keys/`. Whoever holds that key can sign as the treasury: call `ft_transfer` on the token directly, or deploy new code. That bypasses the contract's allowlist, limits, holds, and fund ledgers entirely. A real deployment must delete that key (lock the account) after deploying.

### Policy and key gaps

- **Split bills can bypass the per-bill hold.** The hold applies only when a single bill is over the per-bill limit. Several bills to the same vendor, each at or under the limit, are paid with no hold. Only the monthly cap (a calendar month, UTC) stops the total, and only if it goes over; each bill must also fit its fund's balance. There is no per-vendor or time-window limit.
- **`set_limits` takes effect immediately, while allowlist changes wait 24 hours.** A stolen owner key can raise the per-bill limit at once and make new holds pointless. There is no cancel or veto for a pending allowlist change. The same owner key can only replace the proposal, which restarts the 24-hour wait.
- **Owner methods do not require a 1-yoctoNEAR deposit.** `approve_hold`, `reject_hold`, `credit_fund`, `propose_allowlist_change`, and `set_limits` check only the caller. None is payable or requires 1 yoctoNEAR, so a function-call access key on the owner account could call them. The usual NEAR pattern, requiring 1 yoctoNEAR so only a full-access key (a wallet confirmation) can call, needs new contract code. The contract has no upgrade method, so that means a fresh treasury deploy, or a redeploy with the treasury account's own full-access key, which the demo keeps in `.demo-keys/`.

## Does not cover (yet)

Not built; follow-ups from the fund-accounting review. The page's boundary lines say the same in short.

- Interfund transfers (A8), and explicit loans instead of silent borrowing from restricted funds (A9)
- Showing a release from restriction when a restricted fund pays a bill (A10)
- Board-designated sub-funds (A11)
- A reconciliation worksheet (B5) and the monthly cap / month-to-date spent on the page (B6)
- Required memo / invoice (C6), a reject reason (C7), two-person approval (C8), roles (C9)
- Giving statements / Pub 1771 acknowledgments (D6)
- A per-fund register with running balance (E3), budgets (E4), period close (E5), refunds as adjusting entries (E6), a chart of accounts (E7)

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
- The treasury contract's methods move money only as vendor payouts, each from the fund its bill is tagged to. In this demo the treasury account still has a full-access key in `.demo-keys/`, which could bypass the contract entirely; a real deployment must delete that key (see [Known issues](#known-issues)). The contract enforces the vendor allowlist (with a 24-hour timelock on changes), a per-bill limit, a monthly cap, and per-fund balances. Unusual bills are held for the treasurer.
- There is no matching pool and no quadratic funding.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

The OpenLid name and logo are not licensed under Apache-2.0. See [TRADEMARK.md](TRADEMARK.md).

To report a vulnerability, use GitHub private vulnerability reporting (the repo Security tab, **Report a vulnerability**). See [SECURITY.md](SECURITY.md).

## Credit

OpenLid by Michael McClanahan (@tnvolman).
