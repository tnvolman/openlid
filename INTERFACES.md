# OpenLid interfaces

Shared contract between the `openlid/contract`, `openlid/app`, and `openlid/ui` worktrees. Implement against these names and shapes. Do not invent parallel APIs. Amounts are USDC atomic units (6 decimals) as decimal integer strings in JSON and as `u128` in the contract. Fund tags are exactly `general`, `missions`, or `building`.

Credit: Michael McClanahan (@tnvolman). Standalone project: no Journey Digital, Forge, or JF marks.

## Directory ownership

| Path | Writer |
| --- | --- |
| `contracts/**` | `openlid/contract` |
| `apps/api/**` | `openlid/app` |
| `apps/web/**`, `README.md`, `scripts/**` | `openlid/ui` |
| `INTERFACES.md`, `.env.example`, `.gitignore`, `.github/workflows/**` | integrator on `openlid/main-pr` only |

Do not edit a path you do not own. Do not push, open PRs, merge, deploy, or add secrets.

## Accounts and keys

- `owner` (treasurer): church-controlled NEAR account. In production a hardware wallet or multisig. Signs `approve_hold`, `reject_hold`, `credit_fund`, and allowlist proposals. Never an OpenLid-held key.
- `agent`: church-issued **function-call access key only**, limited to this contract and method `request_payout`. No seed, no full-access key, no implicit private key in repo, logs, or env examples.
- `vendor`: allowlisted NEAR account that can receive payouts.
- `usdc_token`: NEP-141 token account id. On the testnet demo this is a simple test FT (not mainnet USDC). Settlement destination is the treasury contract on the church's testnet account.

Environment variable **names only** (see `.env.example`): `OPENLID_NETWORK`, `OPENLID_CONTRACT_ID`, `OPENLID_OWNER_ACCOUNT_ID`, `OPENLID_AGENT_ACCOUNT_ID`, `OPENLID_AGENT_KEY_FILE`, `OPENLID_OWNER_KEY_FILE`, `OPENLID_USDC_TOKEN_ID`, `OPENLID_DEMO_KEYS_DIR`, `ONECLICK_BASE_URL`, `ONECLICK_API_KEY`, `ONECLICK_DRY_RUN`, `OPENLID_DATA_DIR`. Values and key files stay off-repo.


## Testnet demo (required)

Michael approved a NEAR **testnet-only** demo at 12:45 AM ET on Nov 11, $0 spend. These rules override any earlier "real quote" wording below.

- Everything runs on NEAR testnet. The demo creates a sub-account via the testnet faucet or near-cli. No mainnet accounts, no real funds, no paid APIs.
- NEAR Intents 1Click is mainnet-only. Keep the real 1Click client and the per-gift quote and matching code, but run quotes in **dry-run mode only** (`dry: true`). Official docs: a dry quote does **not** return `depositAddress`. No deposit is ever sent.
- Because a dry quote has no deposit address, the API assigns a unique **simulated** deposit address per gift (prefix `sim:`) and still matches gifts by that address only, never by amount. The matching code must also accept a real `depositAddress` when a non-dry fixture is used in tests, but the demo and default config never call 1Click with `dry: false` and never broadcast a deposit.
- The $0 demo must run with `ONECLICK_API_KEY` unset. If a key is not set, do not call the live 1Click endpoint (it is a paid/partner API). Use the real client against a dry-run-shaped local stub with the same types as `POST /v0/quote` (`dry: true`, no `depositAddress`). Tests mock the HTTP client either way.
- Settlement is **not** a cross-chain transfer. A testnet adapter mints or transfers a testnet USDC-like token (a simple test FT contract) into the church treasury contract, then marks the gift `settled`. The README and the demo must say plainly that the cross-chain leg is a dry-run quote plus a simulated settlement on testnet.
- Testnet keys are generated locally at demo time into `OPENLID_DEMO_KEYS_DIR` (default `.demo-keys/`, gitignored). Nothing in that directory is committed. Key material is never printed to logs, stdout, or error messages (print paths and account ids only).
- Licensed under Apache-2.0 (see `LICENSE` and `NOTICE`). The OpenLid name and logo are not licensed under Apache-2.0; see `TRADEMARK.md`.
- The GitHub repository stays PRIVATE. Never change visibility.

## Contract test FT (`contracts/test-ft`)

A minimal NEP-141 (6 decimals, symbol `tUSDC`) used only on testnet or in unit tests. Owner can `mint(account, amount)` so the demo can credit the treasury. No mainnet deploy.

## Contract (`contracts/treasury`)

Rust `near-sdk` 5. Init once. Panic with a clear message on unauthorized callers, invalid args, or policy violations. Unauthorized caller means the predecessor is not the role required by the method.

### Init

`new(owner: AccountId, agent: AccountId, usdc_token: AccountId, per_bill_limit: U128, monthly_cap: U128, initial_allowlist: Vec<AccountId>)`

- `owner` and `agent` must differ.
- Limits are in USDC atomic units and must be > 0.
- Monthly window is calendar month UTC (`YYYY-MM`). Spent resets when the month changes.
- `initial_allowlist` vendors (may be empty) are active immediately. This is deploy-time configuration, not a later change. Every subsequent add or remove still uses `propose_allowlist_change` and the 24 hour delay.
- Every fund ledger starts at zero: no bill can be paid until the owner has credited its fund.

### Funds (per-fund ledger, enforced on-chain)

Every bill names exactly one fund: `general`, `missions`, or `building`. Any other string panics with `fund must be one of general, missions, building`. The contract keeps a ledger per fund:

- `received`: increased only by the owner's `credit_fund`, once per settled gift.
- `paid`: increased by every successful payout from the fund (auto-pay or approved hold); decreased again if the `ft_transfer` fails and `on_payout_transfer` rolls the payout back (like `month_spent`).
- `available = received - paid` (saturating, never negative).
- `held`: sum of outstanding (`held`) holds on the fund. Shown in views but does **not** reduce `available`; instead `approve_hold` re-checks `available` at approval time.

A bill (auto-pay **or** hold creation) with `amount > available` for its fund panics with `insufficient fund balance: <fund> has <available> available, bill needs <amount>`. So does `approve_hold` when the fund no longer covers the hold (for example another payout used it after the hold was created). A missions gift can never pay a building bill.

The contract cannot see gifts (they live in the API store), and `credit_fund` does not move tokens: it only records that tokens the treasury already holds belong to a fund. All funds share one NEP-141 balance; the ledger is what keeps them apart. The token balance must therefore be credited first (testnet demo: test-FT `mint` into the treasury), then `credit_fund`. Tokens that reach the treasury without a `credit_fund` (for example a direct `ft_transfer`) belong to no fund and cannot be spent by a bill.

### Change methods

| Method | Caller | Args | Behavior |
| --- | --- | --- | --- |
| `request_payout` | `agent` only | `vendor: AccountId, amount: U128, bill_id: String, memo: String, fund: String` | `fund` must be `general`, `missions`, or `building`; `bill_id` must be unique and non-empty; `amount` > 0. If `vendor` is active on the allowlist, `amount <= per_bill_limit`, `month_spent + amount <= monthly_cap`, and `amount <= available(fund)`, transfer USDC to `vendor` immediately, add `amount` to the fund's `paid`, and record a payout with status `paid`. If `vendor` is active, `amount > per_bill_limit`, `month_spent + amount <= monthly_cap`, and `amount <= available(fund)`, create a hold (`status: "held"`) and do not transfer. Otherwise panic (invalid fund, unknown vendor, inactive vendor, cap exceeded, insufficient fund balance, duplicate `bill_id`). |
| `approve_hold` | `owner` only | `bill_id: String` | Hold must be `held`. Re-check cap, that the vendor is still active on the allowlist, and that `amount <= available` for the hold's fund. Transfer USDC, add to the fund's `paid`, mark payout `paid`, mark hold `approved`. |
| `reject_hold` | `owner` only | `bill_id: String` | Hold must be `held`. Mark hold `rejected`. No transfer. Does not consume cap. Does not change the fund ledger. |
| `credit_fund` | `owner` only | `fund: String, amount: U128, gift_id: String` | Valid fund; `amount` > 0; `gift_id` non-empty and never credited before (`duplicate gift_id: gift already credited`, so a retried settlement cannot double-count). Adds `amount` to the fund's `received`. **Ledger only: moves no tokens.** The caller must already have credited the treasury's token balance. |
| `propose_allowlist_change` | `owner` only | `vendor: AccountId, action: String` | `action` is `add` or `remove`. Stores a proposal with `execute_after = now + 24 hours` (86_400_000_000_000 ns). Replaces any pending proposal for the same vendor. |
| `execute_allowlist_change` | any account | `vendor: AccountId` | Pending proposal must exist and `block_timestamp >= execute_after`. Then add or remove the vendor. Calling before the delay panics. |
| `set_limits` | `owner` only | `per_bill_limit: U128, monthly_cap: U128` | Both > 0. Takes effect immediately. Does not change current `month_spent`. |

The contract enforces limits, allowlist, and the 24h delay itself. The agent cannot bypass them.

### Views

| Method | Args | Returns |
| --- | --- | --- |
| `get_config` | none | `ConfigView` |
| `get_allowlist` | none | `Vec<AccountId>` (active vendors only) |
| `get_proposal` | `vendor: AccountId` | `Option<AllowlistProposalView>` |
| `get_payout` | `bill_id: String` | `Option<PayoutView>` |
| `get_hold` | `bill_id: String` | `Option<HoldView>` |
| `list_holds` | `status: Option<String>` | `Vec<HoldView>` (`held`, `approved`, `rejected`, or all if `None`) |
| `get_month_spent` | none | `MonthSpentView` |
| `get_fund` | `fund: String` | `FundView` (panics on an unknown fund) |
| `get_fund_ledger` | none | `Vec<FundView>` for `general`, `missions`, `building`, in that order |

```text
ConfigView { owner, agent, usdc_token, per_bill_limit, monthly_cap }
AllowlistProposalView { vendor, action, execute_after }
PayoutView { bill_id, vendor, amount, memo, fund, status }  // status: "paid"
HoldView { bill_id, vendor, amount, memo, fund, status }     // held | approved | rejected
MonthSpentView { year_month, spent, cap }                   // year_month like "2026-11"
FundView { fund, received, paid, available, held }          // available = received - paid
```

### Events (NEP-297)

Emit under standard `EVENT_JSON:` with `standard: "openlid", version: "1.0.0"`.

| Event | Data |
| --- | --- |
| `payout_requested` | `bill_id, vendor, amount, memo, fund` |
| `payout_executed` | `bill_id, vendor, amount, fund` |
| `payout_held` | `bill_id, vendor, amount, fund, reason` (`over_per_bill_limit`) |
| `fund_credited` | `fund, amount, gift_id, received` (fund's new `received` total) |
| `hold_approved` | `bill_id` |
| `hold_rejected` | `bill_id` |
| `allowlist_proposed` | `vendor, action, execute_after` |
| `allowlist_executed` | `vendor, action` |
| `limits_updated` | `per_bill_limit, monthly_cap` |

## 1Click (dry-run only in the demo)

Use the public 1Click API as documented at https://docs.near-intents.org. Base URL default: `https://1click.chaindefuser.com`. Auth header name: `X-API-Key`. Tests **must mock** these HTTP calls. The demo never touches mainnet funds and never sends a deposit.

### `POST /v0/quote`

Request (required fields from the official schema): `dry`, `swapType`, `slippageTolerance`, `originAsset`, `depositType`, `destinationAsset`, `amount`, `refundTo`, `refundType`, `recipient`, `recipientType`, `deadline`.

OpenLid demo and default config always use:

- `dry: true` (official schema: response does **not** contain `depositAddress`, `timeWhenInactive`, or `deadline`)
- `swapType: "EXACT_INPUT"`
- `depositType: "ORIGIN_CHAIN"`
- `recipientType: "DESTINATION_CHAIN"`
- `recipient`: the church treasury contract account on testnet
- `destinationAsset`: configured asset id (env). The live 1Click path is not how testnet settlement happens.

The client code may still parse a non-dry response (including `quote.depositAddress`) so tests can cover matching against the official shape. The demo must not send `dry: false` and must not use a payable deposit address.

Response fields we persist when present: `correlationId`, `signature`, `timestamp`, `quote.depositAddress`, `quote.depositMemo` (optional), `quote.amountIn`, `quote.amountOut`, `quote.minAmountOut`, `quote.deadline`.

**One quote and one deposit address per gift.** If the (dry) quote has no `depositAddress`, assign a unique simulated address `sim:<id>` and persist that. Never reuse an address. Match gifts by deposit address only, never by amount.

### `GET /v0/status?depositAddress={address}`

Include `depositMemo` as a query param when the quote returned one. Status enum from the official API:

`PENDING_DEPOSIT` | `KNOWN_DEPOSIT_TX` | `PROCESSING` | `SUCCESS` | `REFUNDED` | `FAILED` | `INCOMPLETE_DEPOSIT`

## HTTP API (`apps/api`, default bind `127.0.0.1:8787`)

JSON only, except the CSV export. No secrets in responses. Receipt-facing copy must include the exact phrase `demo, not a tax document`.

### Gifts

`POST /api/gifts/quote`

```json
{
  "donor": "string, required, non-empty display name or donor reference (not a secret)",
  "fund": "general | missions | building",
  "originAsset": "1Click asset id",
  "amount": "integer string in origin asset atomic units",
  "refundTo": "origin-chain address for 1Click refunds",
  "refundType": "ORIGIN_CHAIN",
  "slippageTolerance": 100
}
```

Behavior: obtain a dry-run quote (live client with `dry: true` only if `ONECLICK_API_KEY` is set; otherwise a local dry-run-shaped stub — no paid API call). Persist one gift keyed by `quote.depositAddress` or, if absent, a new unique `sim:<id>` address. Return `quoteMode: "dry_run"` and:

```json
{
  "id": "gift id",
  "donor": "...",
  "fund": "general",
  "depositAddress": "0x...",
  "depositMemo": null,
  "correlationId": "...",
  "amountIn": "...",
  "amountOut": "...",
  "originAsset": "...",
  "status": "pending_deposit",
  "quoteMode": "dry_run",
  "receiptNote": "demo, not a tax document"
}
```

`GET /api/gifts` — optional query `fund`. Returns `{ "gifts": Gift[] }` newest first.

`GET /api/gifts/:id`

`POST /api/gifts/:id/sync` — for a gift with a real 1Click deposit address, poll `GET /v0/status` and map as below. For a simulated `sim:` address, do not call live 1Click; leave status unchanged unless a testnet settlement has occurred.

`POST /api/gifts/:id/simulate-settlement` — **testnet only**. Refuses if `OPENLID_NETWORK` is `mainnet`. Mints the test FT into the treasury contract for this gift's `amountOut`, then the owner signs `credit_fund(fund, amount, gift_id)` with this gift's fund, amount, and id. Sets status `settled` only if **both** succeed; if `credit_fund` fails the request fails (`422` for a contract rejection) and the gift stays unsettled. This is the simulated cross-chain settlement. Never sends a 1Click deposit.

Settlement → ledger: the mint is what puts tokens in the treasury; `credit_fund` is what assigns them to a fund. Only simulated settlement calls `credit_fund` today. A gift that reaches `settled` via `sync` (real 1Click `SUCCESS`, not used in the demo) is counted in `/api/summary` but is not credited on-chain until the owner calls `credit_fund` for it.

Gift `status` mapping (store OpenLid names, never guess a match by amount):

| 1Click | OpenLid |
| --- | --- |
| `PENDING_DEPOSIT` | `pending_deposit` |
| `KNOWN_DEPOSIT_TX`, `PROCESSING`, `INCOMPLETE_DEPOSIT` | `processing` |
| `SUCCESS` | `settled` |
| `REFUNDED` | `refunded` |
| `FAILED` | `failed` |

`settled` means the test FT has been credited to the church-owned treasury contract (simulated settlement on testnet). Failed and refunded are first-class statuses, not folded into pending. The matching tests still map 1Click `SUCCESS` / `REFUNDED` / `FAILED` from mocked status payloads.

### Payouts and holds

`POST /api/payouts/request` — agent path. Body: `{ "vendor": "...", "amount": "...", "billId": "...", "memo": "...", "fund": "general | missions | building" }`. `fund` is required; a missing or unknown fund is `400 { "error": "fund must be one of general, missions, building" }` before the contract is called. The API signs `request_payout` (with `fund`) using the function-call key from `OPENLID_AGENT_KEY_FILE`. Returns `{ "billId", "status": "paid" | "held", "vendor", "amount", "fund" }` or a 4xx with `{ "error": "..." }` when the contract rejects (`422`, e.g. `contract rejected: insufficient fund balance: building has 0 available, bill needs 50000000`).

`GET /api/payouts` — `{ "payouts": PayoutView[] }` (each with `fund`)

`GET /api/holds?status=held` — `{ "holds": HoldView[] }` (each with `fund`)

`POST /api/holds/:billId/approve` and `POST /api/holds/:billId/reject` — treasurer path. In the demo these call the contract as `owner`. The owner key, if used at all, is a local file path in env, never committed. Returns `{ billId, status, hold }` (`hold` includes `fund`). An approve the fund can no longer cover is `422 { "error": "contract rejected: insufficient fund balance: ..." }` and the hold stays `held`. An approve whose `ft_transfer` is rolled back is `422` and is not recorded as paid.

### Treasurer export and summary

`GET /api/summary`:

```json
{
  "giftsByFund": {
    "general":  { "count": 1, "received": "100000000", "paidOut": "0", "held": "90000000", "available": "100000000" },
    "missions": { "count": 1, "received": "60000000", "paidOut": "0", "held": "0", "available": "60000000" },
    "building": { "count": 1, "received": "250000000", "paidOut": "180000000", "held": "0", "available": "70000000" }
  },
  "treasuryBalance": "230000000",
  "payouts": { "paidCount": 1, "paidAmount": "180000000" },
  "holds": { "heldCount": 1, "heldAmount": "90000000" },
  "receiptNote": "demo, not a tax document"
}
```

Per fund: `count` settled gifts; `received` sum of settled gift amounts; `paidOut` sum of paid payouts from the fund; `held` sum of outstanding (`held`) holds on the fund; `available = received - paidOut` (holds do not reduce it, matching the contract). All amounts are atomic-unit decimal strings. `treasuryBalance` is the live NEP-141 balance of the treasury contract (`null` if unreadable). The old `settledAmount` field is gone; use `received`.

`GET /api/export.csv` — CSV of gifts and payouts (two sections or a `type` column). Payout rows carry their `fund`. Include a header comment or first row note: `demo, not a tax document`.

## Payout request flow

0. A gift settles (`simulate-settlement`): tUSDC is minted into the treasury, then the owner calls `credit_fund(gift.fund, amount, gift.id)`, raising that fund's `received`.
1. Treasurer or a bookkeeping helper submits a bill to `POST /api/payouts/request` with vendor, amount, unique `billId`, memo, and `fund`.
2. The API validates `fund` and, using only the agent's restricted function-call key, calls `request_payout` on the treasury contract.
3. The contract checks caller, fund name, allowlist, unique `bill_id`, per-bill limit, monthly cap, and that the bill fits the fund's `available`.
4. If the vendor is allowlisted, amount is at or under the per-bill limit, the cap has room, and the fund covers it: USDC transfers to the vendor; the fund's `paid` grows; status `paid`. Demo must include one such bill.
5. If the vendor is allowlisted, amount is above the per-bill limit, the cap has room, and the fund covers it: no transfer; a hold is created. The treasurer later calls `approve_hold` (which re-checks cap, allowlist, and fund) or `reject_hold` with the church owner key. Demo must include one such unusual bill, left held until approved.
6. Any other case is rejected on-chain. The agent cannot pay an unknown vendor, exceed the cap, skip the hold path, or pay a bill from another fund's money.

## Breaking change: per-fund ledger (contract state and ABI)

The per-fund ledger changes the treasury's Borsh state (`Payout` and `Hold` gained `fund`; new `fund_ledger` and `credited_gifts` collections) and its ABI (`request_payout` requires `fund`; new `credit_fund`, `get_fund`, `get_fund_ledger`). There is no migration method. The existing testnet treasury `treasury.openlid-demo-mwbp9t7m.testnet` **cannot be upgraded in place**: new code would fail to deserialize its old state, and its fund ledgers would be empty anyway. Use a **fresh demo account and redeploy**. `scripts/testnet/setup.mjs` only deploys when its `state.json` says it has not, so point it at a new keys directory (a new faucet root account and fresh contracts, nothing reused):

```bash
# Documentation only. Not run as part of this change. Testnet, $0.
(cd contracts/treasury && cargo build --target wasm32-unknown-unknown --release)
(cd contracts/test-ft && cargo build --target wasm32-unknown-unknown --release)
OPENLID_DEMO_KEYS_DIR=.demo-keys/fund-ledger scripts/demo.sh --once   # new root account; keys stay under gitignored .demo-keys/
```

Alternatively, an in-place upgrade would need a `#[private] #[init(ignore_state)] migrate()` that reads the old layout, assigns every existing payout and hold a fund, and seeds each fund's `received` from settled gifts; that is not implemented.

## UI (`apps/web`)

Treasurer page against the HTTP API:

- Gifts grouped by fund, with status including `refunded` and `failed`
- Per-fund summary (Fund, Gifts, Received, Paid out, Available) and the live on-chain treasury balance
- Payouts and outstanding holds, each with its fund
- Approve / reject hold actions
- CSV download via `/api/export.csv`
- Visible receipt label: `demo, not a tax document`

`scripts/demo.sh` runs on NEAR testnet only ($0, no mainnet, no paid APIs). It creates a testnet sub-account via the faucet or near-cli, writes keys only to `.demo-keys/` (gitignored, never printed), deploys or uses the test FT and treasury contracts, starts the API and UI, takes a dry-run quote (or stub), simulates settlement of at least one gift into the contract, and seeds one auto-paid allowlisted bill plus one held unusual bill. It must print a plain-language notice that the cross-chain leg is a dry-run quote plus a simulated settlement on testnet. If faucet or deploy cannot run on this machine, fail honestly and document it; do not fake a testnet receipt.

## Tests each tree must leave green

- Contract: cap, per-bill limit, allowlist add/remove, 24h delay (too early fails, after delay succeeds), hold + treasurer approve, unauthorized caller rejected for `request_payout` and `approve_hold`; invalid fund rejected, insufficient fund refused for auto-pay and hold creation, `approve_hold` blocked when the fund no longer covers it, `credit_fund` owner-only with duplicate `gift_id` rejected, ledger math, fund in views, and `paid` restored on transfer rollback. Prefer `near-sdk` unit tests; `near-workspaces` sandbox is optional and must not be faked if it will not run.
- App: dry-run quote persists a unique deposit address per gift (`sim:` when the quote has none); two gifts never share an address; mocked sync maps `SUCCESS` → `settled`, `REFUNDED` → `refunded`, `FAILED` → `failed`; matching is by deposit address only (a second gift with the same amount does not steal the first gift's status); `simulate-settlement` credits the test FT, calls `credit_fund` for the gift's fund, and marks `settled` (not if `credit_fund` fails), and is refused when the network is mainnet; payout `fund` required/validated, insufficient-fund and approve-blocked-by-fund are 4xx, and summary per-fund math holds.
- UI / README: setup, architecture, known-issues, the testnet-only / dry-run plus simulated settlement wording, the Apache-2.0 license line, and a short POTLOCK comparison written from POTLOCK's public docs (open public-goods / quadratic-funding pots vs OpenLid's church treasury with on-contract vendor policy). No invented POTLOCK claims.
