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

- `owner` (treasurer): church-controlled NEAR account. In production a hardware wallet or multisig. Signs `approve_hold`, `reject_hold`, and allowlist proposals. Never an OpenLid-held key.
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

### Change methods

| Method | Caller | Args | Behavior |
| --- | --- | --- | --- |
| `request_payout` | `agent` only | `vendor: AccountId, amount: U128, bill_id: String, memo: String` | `bill_id` must be unique and non-empty; `amount` > 0. If `vendor` is active on the allowlist, `amount <= per_bill_limit`, and `month_spent + amount <= monthly_cap`, transfer USDC to `vendor` immediately and record a payout with status `paid`. If `vendor` is active, `amount > per_bill_limit`, and `month_spent + amount <= monthly_cap`, create a hold (`status: "held"`) and do not transfer. Otherwise panic (unknown vendor, inactive vendor, cap exceeded, duplicate `bill_id`). |
| `approve_hold` | `owner` only | `bill_id: String` | Hold must be `held`. Re-check cap and that the vendor is still active on the allowlist. Transfer USDC, mark payout `paid`, mark hold `approved`. |
| `reject_hold` | `owner` only | `bill_id: String` | Hold must be `held`. Mark hold `rejected`. No transfer. Does not consume cap. |
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

```text
ConfigView { owner, agent, usdc_token, per_bill_limit, monthly_cap }
AllowlistProposalView { vendor, action, execute_after }
PayoutView { bill_id, vendor, amount, memo, status }  // status: "paid"
HoldView { bill_id, vendor, amount, memo, status }     // held | approved | rejected
MonthSpentView { year_month, spent, cap }             // year_month like "2026-11"
```

### Events (NEP-297)

Emit under standard `EVENT_JSON:` with `standard: "openlid", version: "1.0.0"`.

| Event | Data |
| --- | --- |
| `payout_requested` | `bill_id, vendor, amount, memo` |
| `payout_executed` | `bill_id, vendor, amount` |
| `payout_held` | `bill_id, vendor, amount, reason` (`over_per_bill_limit`) |
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

`POST /api/gifts/:id/simulate-settlement` — **testnet only**. Refuses if `OPENLID_NETWORK` is `mainnet`. Mints or transfers the test FT into the treasury contract for this gift's `amountOut` (or quoted amount) and sets status `settled`. This is the simulated cross-chain settlement. Never sends a 1Click deposit.

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

`POST /api/payouts/request` — agent path. Body: `{ "vendor": "...", "amount": "...", "billId": "...", "memo": "..." }`. The API signs `request_payout` with the function-call key from `OPENLID_AGENT_KEY_FILE`. Returns `{ "billId", "status": "paid" | "held", "vendor", "amount" }` or a 4xx with `{ "error": "..." }` when the contract rejects.

`GET /api/payouts` — `{ "payouts": PayoutView[] }`

`GET /api/holds?status=held` — `{ "holds": HoldView[] }`

`POST /api/holds/:billId/approve` and `POST /api/holds/:billId/reject` — treasurer path. In the demo these call the contract as `owner`. The owner key, if used at all, is a local file path in env, never committed.

### Treasurer export and summary

`GET /api/summary` — `{ "giftsByFund": { "general": { "settledAmount", "count" }, "missions": {...}, "building": {...} }, "payouts": { "paidCount", "paidAmount" }, "holds": { "heldCount", "heldAmount" }, "receiptNote": "demo, not a tax document" }`

`GET /api/export.csv` — CSV of gifts and payouts (two sections or a `type` column). Include a header comment or first row note: `demo, not a tax document`.

## Payout request flow

1. Treasurer or a bookkeeping helper submits a bill to `POST /api/payouts/request` with vendor, amount, unique `billId`, and memo.
2. The API, using only the agent's restricted function-call key, calls `request_payout` on the treasury contract.
3. The contract checks caller, allowlist, unique `bill_id`, per-bill limit, and monthly cap.
4. If the vendor is allowlisted, amount is at or under the per-bill limit, and the cap has room: USDC transfers to the vendor; status `paid`. Demo must include one such bill.
5. If the vendor is allowlisted, amount is above the per-bill limit, and the cap has room: no transfer; a hold is created. The treasurer later calls `approve_hold` or `reject_hold` with the church owner key. Demo must include one such unusual bill, left held until approved.
6. Any other case is rejected on-chain. The agent cannot pay an unknown vendor, exceed the cap, or skip the hold path.

## UI (`apps/web`)

Treasurer page against the HTTP API:

- Gifts grouped by fund, with status including `refunded` and `failed`
- Payouts and outstanding holds
- Approve / reject hold actions
- CSV download via `/api/export.csv`
- Visible receipt label: `demo, not a tax document`

`scripts/demo.sh` runs on NEAR testnet only ($0, no mainnet, no paid APIs). It creates a testnet sub-account via the faucet or near-cli, writes keys only to `.demo-keys/` (gitignored, never printed), deploys or uses the test FT and treasury contracts, starts the API and UI, takes a dry-run quote (or stub), simulates settlement of at least one gift into the contract, and seeds one auto-paid allowlisted bill plus one held unusual bill. It must print a plain-language notice that the cross-chain leg is a dry-run quote plus a simulated settlement on testnet. If faucet or deploy cannot run on this machine, fail honestly and document it; do not fake a testnet receipt.

## Tests each tree must leave green

- Contract: cap, per-bill limit, allowlist add/remove, 24h delay (too early fails, after delay succeeds), hold + treasurer approve, unauthorized caller rejected for `request_payout` and `approve_hold`. Prefer `near-sdk` unit tests; `near-workspaces` sandbox is optional and must not be faked if it will not run.
- App: dry-run quote persists a unique deposit address per gift (`sim:` when the quote has none); two gifts never share an address; mocked sync maps `SUCCESS` → `settled`, `REFUNDED` → `refunded`, `FAILED` → `failed`; matching is by deposit address only (a second gift with the same amount does not steal the first gift's status); `simulate-settlement` credits the test FT and marks `settled`, and is refused when the network is mainnet.
- UI / README: setup, architecture, known-issues, the testnet-only / dry-run plus simulated settlement wording, the Apache-2.0 license line, and a short POTLOCK comparison written from POTLOCK's public docs (open public-goods / quadratic-funding pots vs OpenLid's church treasury with on-contract vendor policy). No invented POTLOCK claims.
