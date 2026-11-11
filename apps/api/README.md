# OpenLid API (`apps/api`)

Small TypeScript HTTP API for OpenLid: records gifts using NEAR Intents **1Click** quotes, and lets an agent request vendor payouts from the church treasury contract. Contracts and UI live elsewhere; the API shapes come from [`INTERFACES.md`](../../INTERFACES.md).

Receipts and exports say **"demo, not a tax document"**.

> **NEAR testnet only, $0 spend.** The cross-chain leg is a **1Click dry-run quote plus a simulated settlement on NEAR testnet**. Every quote is sent with `dry: true`. No payable deposit address is requested, and no deposit is ever sent. Each gift gets a simulated `sim:<id>` deposit address. "Settling" a gift mints the testnet test FT (tUSDC) into the treasury contract; it is not a cross-chain transfer. Mainnet is refused (`OPENLID_NETWORK=mainnet` throws at startup, and `simulate-settlement` returns 403).

License: to be decided.

## Run

Requires Node 22.

```sh
cd apps/api
npm install
npm test            # node:test via tsx, all HTTP to 1Click and NEAR is mocked
npm run typecheck   # tsc --noEmit
npm start           # binds 127.0.0.1:8787 by default
```

Put your settings in a private `.env` (never committed) and export them, e.g. `set -a; . ../../.env; set +a; npm start`.

CORS allows `http://127.0.0.1:5173` and `http://localhost:5173` (the Vite UI).

## Environment (names only)

| Name | Used for |
| --- | --- |
| `OPENLID_NETWORK` | `testnet` (default). `mainnet` is refused at startup. `simulate-settlement` only runs on `testnet`. |
| `OPENLID_NEAR_RPC_URL` | NEAR JSON-RPC used for all contract views, signing, and the treasury balance. Default for `testnet`: `https://rpc.testnet.fastnear.com`. The official `https://rpc.testnet.near.org` is deprecated and currently answers HTTP 429, so it is not the default; set this to use another provider. Empty means unset. Only the host is logged. |
| `OPENLID_CONTRACT_ID` | Treasury contract. Also the 1Click `recipient`. |
| `OPENLID_USDC_TOKEN_ID` | Testnet test FT (tUSDC) account. 1Click `destinationAsset` is `nep141:<this>`; simulated settlement mints this token. |
| `OPENLID_AGENT_ACCOUNT_ID` | Account that owns the agent's function-call key. |
| `OPENLID_AGENT_KEY_FILE` | **Path** to the agent key file (see below). Never the key itself. |
| `OPENLID_OWNER_ACCOUNT_ID` | Treasurer account (treasury `owner`), for demo approve/reject and the `credit_fund` ledger update at settlement (simulated or `/sync` SUCCESS). In the demo it is also the test FT owner that calls `mint`. |
| `OPENLID_OWNER_KEY_FILE` | Optional path to a demo owner key. Leave it unset if the treasurer signs with their own wallet. |
| `OPENLID_DEMO_KEYS_DIR` | Gitignored directory where the demo generates testnet keys. If an `*_KEY_FILE` is unset, the API looks for `<dir>/<accountId>.json`. Use an absolute path, because relative paths resolve from the API's working directory. |
| `ONECLICK_BASE_URL` | Default `https://1click.chaindefuser.com`. Only used when `ONECLICK_API_KEY` is set. |
| `ONECLICK_API_KEY` | **Leave unset for the $0 demo.** When unset, the API never calls the live 1Click (paid/partner) API. It sends the same requests through the real client to a local dry-run stub. When set, it is sent as `X-API-Key`, still with `dry: true` only. Never logged or returned. |
| `ONECLICK_DRY_RUN` | Must be `true` or unset. Any other value refuses to start, because this build has no non-dry path. |
| `OPENLID_DATA_DIR` | Where `gifts.json` / `payouts.json` are stored (default `./data`, gitignored). |
| `OPENLID_API_HOST`, `OPENLID_API_PORT` | Bind address, default `127.0.0.1` / `8787`. |

If the contract, agent account, or agent key file is missing, the gift endpoints still work. Payout and hold endpoints return `503`, and `/api/summary` reports `holds.available: false`.

### Agent key: restricted function-call key only

`POST /api/payouts/request` signs `request_payout` with the key at `OPENLID_AGENT_KEY_FILE`. That key **must be a NEAR function-call access key** restricted to `receiver_id = OPENLID_CONTRACT_ID` and `method_names = ["request_payout"]`. Before the first use, the API looks up the key on-chain with `view_access_key`. It **refuses full-access keys**, and keys scoped to any other contract or method. A function-call key can't move funds directly, so the agent can only *ask* the contract to pay. The contract enforces the allowlist, per-bill limit, monthly cap, hold path, and per-fund balance (a bill names a fund and can only be paid from that fund's on-chain uncommitted `available = received - paid - held`; holds reserve their amount).

You can issue one with NEAR CLI, something like `near account add-key <agent> grant-function-call-access --receiver-account-id <contract> --method-names request_payout ...`. Keep the generated key file outside this repository.

The key file can be a NEAR CLI credentials JSON (`{"account_id","public_key","private_key"}`) or a file containing only the `ed25519:...` string. Keys are read only from those env paths or from `OPENLID_DEMO_KEYS_DIR`. Key material is never logged, printed, or included in error messages. Errors name the file path only.

The agent key is never used for `approve_hold` / `reject_hold`. Those are treasurer (owner) actions, signed only with `OPENLID_OWNER_KEY_FILE` if configured. Otherwise they return `503`, and the treasurer signs from their own wallet.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/gifts/quote` | Validates `donor`, `fund` (`general`/`missions`/`building`), `originAsset`, `amount` (integer string), `refundTo`, optional `refundType` (`ORIGIN_CHAIN`), `slippageTolerance` (bps, default 100). Gets one **dry-run** quote (`dry: true`). Stores one gift keyed by `quote.depositAddress`, or by a new unique `sim:<id>` when the quote has none (the normal dry-run case). Returns `201` with the gift, including `quoteMode: "dry_run"` and `receiptNote`. |
| GET | `/api/gifts[?fund=]` | `{ gifts: Gift[] }`, newest first. |
| GET | `/api/gifts/:id` | One gift. |
| POST | `/api/gifts/:id/sync` | For a real 1Click address (test fixtures only), polls `GET /v0/status?depositAddress=…[&depositMemo=…]` and maps the status. On `SUCCESS` it takes the same settlement path as `simulate-settlement` (shared `settleGift`): on testnet mint tUSDC (1Click is dry-run and delivers nothing), then `credit_fund(fund, amount, gift_id)` with `amount = swapDetails.amountOut ?? amountOut`. The gift is `settled` only if both succeed; if the credit fails it stays `processing` (with `oneClickStatus: "SUCCESS"`), the mint tx is recorded, and the next sync credits only. Re-syncing a `settled` gift is a no-op (no 1Click call, no mint, no credit). Other statuses never mint or credit. For a `sim:` address, it doesn't call 1Click and returns the gift unchanged. |
| POST | `/api/gifts/:id/simulate-settlement` | **Testnet only** (403 on `mainnet` or any other network). For a `sim:` gift that is `pending_deposit`/`processing`, mints `amountOut` of the test FT into the treasury contract (`mint(account, amount)`, signed by the test FT owner), then signs the treasury's owner-only `credit_fund(fund, amount, gift_id)` with the gift's fund, amount and id. Only if both succeed is the gift marked `settled` with `settlementTxHash` (the mint tx); if `credit_fund` fails the request fails, the gift stays unsettled, and the mint is recorded so a retry credits only. Returns `409` if already settled or not a `sim:` gift, `503` if not configured. Never sends a 1Click deposit. |
| POST | `/api/payouts/request` | `{ vendor, amount, billId, memo, fund }` → `{ billId, status: "paid"|"held", vendor, amount, fund, requestedAt, txHash }`. `fund` is required (`general`/`missions`/`building`, else `400`). A contract panic, e.g. `insufficient fund balance: building has 0 available, bill needs 50000000`, returns `422 { error }`. |
| GET | `/api/payouts` | `{ payouts: PayoutRow[] }`, paid payouts submitted through this API: the contract view (`bill_id, vendor, amount, memo, fund, status`) plus `requestedAt`, `paidAt`, `paymentTxHash` (the paying tx: `request_payout` for auto-pay, `approve_hold` for a hold) and `requestTxHash`. |
| GET | `/api/holds[?status=held|approved|rejected]` | `{ holds: HoldRow[] }` from contract `list_holds` (with `fund`), plus `requestedAt`, `requestTxHash`, and once approved `paidAt` / `paymentTxHash` from this API's records. |
| POST | `/api/holds/:billId/approve`, `/reject` | Treasurer path (owner key). |
| GET | `/api/summary` | `giftsByFund.{general,missions,building}` = `{ restriction, count, received, paidOut, held, available }` (`available = received - paidOut - held`, uncommitted; `restriction` is `with donor restrictions` for missions/building, `without donor restrictions` for general), `treasuryBalance`, `reconciliation` (`{ cash, ledgerTotal, ledgerSource, difference, status: match|mismatch|unknown }`, cash vs the on-chain fund ledgers), paid payouts, outstanding holds, `receiptNote`. |
| GET | `/api/export.csv` | Three `#` comment lines (`demo, not a tax document`, not an IRS Pub 1771 acknowledgment, not GAAP statements / audit), then one table with a `type` column (`gift` / `payout`), `fund` and `restriction` on every row, `created_at`, `paid_at`, `payment_ref` (settlement or payment tx), `request_ref`; then a per-fund reconciliation section (`fund,restriction,gifts,received,paid,held,available`) and a cash-vs-ledgers line. Cells starting with `= + - @` are prefixed with `'` so spreadsheets don't run them as formulas. |

Status mapping: `PENDING_DEPOSIT`→`pending_deposit`; `KNOWN_DEPOSIT_TX`, `PROCESSING`, `INCOMPLETE_DEPOSIT`→`processing`; `SUCCESS`→`settled`; `REFUNDED`→`refunded`; `FAILED`→`failed`.

Errors are always `{ "error": "..." }`: `400` validation, `403` settlement refused (not testnet), `404` not found, `409` reused deposit address, duplicate `billId`, or gift not settleable, `422` contract rejection, `502` 1Click failure, `503` not configured.

## Gift rules

- One dry-run 1Click quote and one deposit address per gift. Official dry quotes have no `depositAddress`, so the API assigns `sim:<gift id>`, which is unique by construction. If a quote ever returns an address already assigned to a gift (compared case-insensitively), the quote is rejected with `409` and no gift is created. A quote that returns a `sim:` address itself is rejected with `502`.
- Status is only ever looked up by the gift's own `depositAddress` (plus `depositMemo` when present). If the status response echoes a different address, it is rejected. Gifts are **never** matched by amount.
- `failed` and `refunded` are terminal statuses in their own right. They are never folded into pending.
- Responses never include the donor's `refundTo` address, the 1Click quote signature, or any key material.

## How tests mock 1Click and NEAR

- **1Click:** tests use the production `HttpOneClickClient` with an injected `fetch` (`MockOneClick` in `test/helpers.ts`). By default the mock returns the official dry-run shape, with no `depositAddress`. Queuing an address turns the next response into a non-dry-shaped fixture, so matching against real addresses and the `SUCCESS`/`REFUNDED`/`FAILED` status mapping are still tested. Statuses are keyed by deposit address. The mock records each request, so tests check that every quote has `dry: true`, plus the `X-API-Key` header and the `depositAddress`/`depositMemo` query. The local no-key stub (`createDryRunStubFetch`) is tested separately. No network calls are made.
- **Settlement:** tests inject `FakeSettlement`, which records test-FT credits instead of minting and then calls `FakeTreasury.creditFund` (the fake `credit_fund`). They cover the happy path (gift becomes `settled`, its fund is credited), refusal on mainnet and on non-testnet networks, double-settle, a failed mint, and a failed `credit_fund` that leaves the gift unsettled with a reconciliation mismatch and is retried credit-only. `/sync` SUCCESS tests cover crediting, re-sync idempotency, a failed credit, a duplicate `gift_id` already on-chain, non-SUCCESS statuses, and no mint outside testnet.
- **Funds:** `FakeTreasury` enforces the contract's fund rules (invalid fund, insufficient balance for auto-pay and hold creation, approve re-check, `paid` rollback on a failed transfer). Tests fund bills by settling a simulated gift to that fund (`h.fundGift(fund, amount)`).
- **NEAR:** tests inject `FakeTreasury`, an in-memory `NearContractClient` that follows the contract policy in `INTERFACES.md` (allowlist, per-bill limit → hold, monthly cap, duplicate `bill_id`). Panics are thrown as `ContractRejectedError`. No key file is needed. The key-file loader test writes a dummy placeholder string to a temp dir.
- Each test uses a fresh temp `OPENLID_DATA_DIR`.

## Known limitations

- `GET /api/payouts` lists payouts submitted through this API instance. The contract has no "list payouts" view, so payouts made by other clients don't show up.
- The JSON store is meant for a single API process.
- The production `NearRpcContractClient` and `NearTestFtSettlement` (near-api-js) typecheck, but they have not been run against testnet in this tree. After `request_payout`, the client reads `get_payout` / `get_hold` back to decide `paid` vs `held`.
- `credit_fund`'s `amount` is set by the owner (here, the API) and is **not** checked on-chain against the tokens minted or received. A wrong amount is caught only by the always-visible cash-vs-ledger reconciliation line.
- If `credit_fund` fails after the mint succeeded, the minted tUSDC stays in the treasury unallocated to any fund (no bill can spend it; the summary shows a mismatch). The mint tx is recorded on the gift, so a retry credits only and does not mint again. If the process dies between the mint and recording it, a retry can still mint twice; the mismatch flag shows it.
- If an earlier `credit_fund` landed on-chain but the API never saw the result, the retry gets `duplicate gift_id` and treats the gift as credited (settles without crediting again).
- Simulated settlement assumes the test FT exposes `mint(account, amount)` callable by `OPENLID_OWNER_ACCOUNT_ID`, and that the treasury can hold the token (storage registration, if the FT requires it, is the demo script's job).
- The no-key dry-run stub quotes 1:1 (`amountOut = amountIn`). That is a placeholder, not a price, and only sensible for a 6-decimal stablecoin origin asset.
