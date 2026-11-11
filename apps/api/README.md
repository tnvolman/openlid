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
| `OPENLID_CONTRACT_ID` | Treasury contract. Also the 1Click `recipient`. |
| `OPENLID_USDC_TOKEN_ID` | Testnet test FT (tUSDC) account. 1Click `destinationAsset` is `nep141:<this>`; simulated settlement mints this token. |
| `OPENLID_AGENT_ACCOUNT_ID` | Account that owns the agent's function-call key. |
| `OPENLID_AGENT_KEY_FILE` | **Path** to the agent key file (see below). Never the key itself. |
| `OPENLID_OWNER_ACCOUNT_ID` | Treasurer account, for demo approve/reject. In the demo it is also the test FT owner that calls `mint` for simulated settlement. |
| `OPENLID_OWNER_KEY_FILE` | Optional path to a demo owner key. Leave it unset if the treasurer signs with their own wallet. |
| `OPENLID_DEMO_KEYS_DIR` | Gitignored directory where the demo generates testnet keys. If an `*_KEY_FILE` is unset, the API looks for `<dir>/<accountId>.json`. Use an absolute path, because relative paths resolve from the API's working directory. |
| `ONECLICK_BASE_URL` | Default `https://1click.chaindefuser.com`. Only used when `ONECLICK_API_KEY` is set. |
| `ONECLICK_API_KEY` | **Leave unset for the $0 demo.** When unset, the API never calls the live 1Click (paid/partner) API. It sends the same requests through the real client to a local dry-run stub. When set, it is sent as `X-API-Key`, still with `dry: true` only. Never logged or returned. |
| `ONECLICK_DRY_RUN` | Must be `true` or unset. Any other value refuses to start, because this build has no non-dry path. |
| `OPENLID_DATA_DIR` | Where `gifts.json` / `payouts.json` are stored (default `./data`, gitignored). |
| `OPENLID_API_HOST`, `OPENLID_API_PORT` | Bind address, default `127.0.0.1` / `8787`. |

If the contract, agent account, or agent key file is missing, the gift endpoints still work. Payout and hold endpoints return `503`, and `/api/summary` reports `holds.available: false`.

### Agent key: restricted function-call key only

`POST /api/payouts/request` signs `request_payout` with the key at `OPENLID_AGENT_KEY_FILE`. That key **must be a NEAR function-call access key** restricted to `receiver_id = OPENLID_CONTRACT_ID` and `method_names = ["request_payout"]`. Before the first use, the API looks up the key on-chain with `view_access_key`. It **refuses full-access keys**, and keys scoped to any other contract or method. A function-call key can't move funds directly, so the agent can only *ask* the contract to pay. The contract enforces the allowlist, per-bill limit, monthly cap, and hold path.

You can issue one with NEAR CLI, something like `near account add-key <agent> grant-function-call-access --receiver-account-id <contract> --method-names request_payout ...`. Keep the generated key file outside this repository.

The key file can be a NEAR CLI credentials JSON (`{"account_id","public_key","private_key"}`) or a file containing only the `ed25519:...` string. Keys are read only from those env paths or from `OPENLID_DEMO_KEYS_DIR`. Key material is never logged, printed, or included in error messages. Errors name the file path only.

The agent key is never used for `approve_hold` / `reject_hold`. Those are treasurer (owner) actions, signed only with `OPENLID_OWNER_KEY_FILE` if configured. Otherwise they return `503`, and the treasurer signs from their own wallet.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/gifts/quote` | Validates `donor`, `fund` (`general`/`missions`/`building`), `originAsset`, `amount` (integer string), `refundTo`, optional `refundType` (`ORIGIN_CHAIN`), `slippageTolerance` (bps, default 100). Gets one **dry-run** quote (`dry: true`). Stores one gift keyed by `quote.depositAddress`, or by a new unique `sim:<id>` when the quote has none (the normal dry-run case). Returns `201` with the gift, including `quoteMode: "dry_run"` and `receiptNote`. |
| GET | `/api/gifts[?fund=]` | `{ gifts: Gift[] }`, newest first. |
| GET | `/api/gifts/:id` | One gift. |
| POST | `/api/gifts/:id/sync` | For a real 1Click address (test fixtures only), polls `GET /v0/status?depositAddress=…[&depositMemo=…]` and maps the status. For a `sim:` address, it doesn't call 1Click and returns the gift unchanged. |
| POST | `/api/gifts/:id/simulate-settlement` | **Testnet only** (403 on `mainnet` or any other network). For a `sim:` gift that is `pending_deposit`/`processing`, mints `amountOut` of the test FT into the treasury contract (`mint(account, amount)`, signed by the test FT owner). Then marks the gift `settled` and records `settlementTxHash`. Returns `409` if already settled or not a `sim:` gift, `503` if not configured. Never sends a 1Click deposit. |
| POST | `/api/payouts/request` | `{ vendor, amount, billId, memo }` → `{ billId, status: "paid"|"held", vendor, amount }`. A contract panic returns `422 { error }`. |
| GET | `/api/payouts` | `{ payouts: PayoutView[] }`, paid payouts submitted through this API. |
| GET | `/api/holds[?status=held|approved|rejected]` | `{ holds: HoldView[] }` from contract `list_holds`. |
| POST | `/api/holds/:billId/approve`, `/reject` | Treasurer path (owner key). |
| GET | `/api/summary` | Settled gifts by fund, paid payouts, outstanding holds, `receiptNote`. |
| GET | `/api/export.csv` | First line `# demo, not a tax document`, then one table with a `type` column (`gift` / `payout`). Cells starting with `= + - @` are prefixed with `'` so spreadsheets don't run them as formulas. |

Status mapping: `PENDING_DEPOSIT`→`pending_deposit`; `KNOWN_DEPOSIT_TX`, `PROCESSING`, `INCOMPLETE_DEPOSIT`→`processing`; `SUCCESS`→`settled`; `REFUNDED`→`refunded`; `FAILED`→`failed`.

Errors are always `{ "error": "..." }`: `400` validation, `403` settlement refused (not testnet), `404` not found, `409` reused deposit address, duplicate `billId`, or gift not settleable, `422` contract rejection, `502` 1Click failure, `503` not configured.

## Gift rules

- One dry-run 1Click quote and one deposit address per gift. Official dry quotes have no `depositAddress`, so the API assigns `sim:<gift id>`, which is unique by construction. If a quote ever returns an address already assigned to a gift (compared case-insensitively), the quote is rejected with `409` and no gift is created. A quote that returns a `sim:` address itself is rejected with `502`.
- Status is only ever looked up by the gift's own `depositAddress` (plus `depositMemo` when present). If the status response echoes a different address, it is rejected. Gifts are **never** matched by amount.
- `failed` and `refunded` are terminal statuses in their own right. They are never folded into pending.
- Responses never include the donor's `refundTo` address, the 1Click quote signature, or any key material.

## How tests mock 1Click and NEAR

- **1Click:** tests use the production `HttpOneClickClient` with an injected `fetch` (`MockOneClick` in `test/helpers.ts`). By default the mock returns the official dry-run shape, with no `depositAddress`. Queuing an address turns the next response into a non-dry-shaped fixture, so matching against real addresses and the `SUCCESS`/`REFUNDED`/`FAILED` status mapping are still tested. Statuses are keyed by deposit address. The mock records each request, so tests check that every quote has `dry: true`, plus the `X-API-Key` header and the `depositAddress`/`depositMemo` query. The local no-key stub (`createDryRunStubFetch`) is tested separately. No network calls are made.
- **Settlement:** tests inject `FakeSettlement`, which records test-FT credits instead of minting. They cover the happy path (gift becomes `settled`), refusal on mainnet and on non-testnet networks, double-settle, and a failed mint that leaves the gift unchanged.
- **NEAR:** tests inject `FakeTreasury`, an in-memory `NearContractClient` that follows the contract policy in `INTERFACES.md` (allowlist, per-bill limit → hold, monthly cap, duplicate `bill_id`). Panics are thrown as `ContractRejectedError`. No key file is needed. The key-file loader test writes a dummy placeholder string to a temp dir.
- Each test uses a fresh temp `OPENLID_DATA_DIR`.

## Known limitations

- `GET /api/payouts` lists payouts submitted through this API instance. The contract has no "list payouts" view, so payouts made by other clients don't show up.
- The JSON store is meant for a single API process.
- The production `NearRpcContractClient` and `NearTestFtSettlement` (near-api-js) typecheck, but they have not been run against testnet in this tree. After `request_payout`, the client reads `get_payout` / `get_hold` back to decide `paid` vs `held`.
- Simulated settlement assumes the test FT exposes `mint(account, amount)` callable by `OPENLID_OWNER_ACCOUNT_ID`, and that the treasury can hold the token (storage registration, if the FT requires it, is the demo script's job).
- The no-key dry-run stub quotes 1:1 (`amountOut = amountIn`). That is a placeholder, not a price, and only sensible for a 6-decimal stablecoin origin asset.
