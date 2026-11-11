# OpenLid API (`apps/api`)

Small TypeScript HTTP API for OpenLid: takes gifts through the NEAR Intents **1Click** API (any supported origin asset → USDC on NEAR, delivered to the church treasury contract), and lets an agent request vendor payouts from the treasury contract. Contracts and UI live elsewhere; the API shapes come from [`INTERFACES.md`](../../INTERFACES.md).

Receipts and exports say **"demo, not a tax document"**. This is a testnet / local demo. Mainnet is refused (`OPENLID_NETWORK=mainnet` throws at startup).

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
| `OPENLID_NETWORK` | `testnet` (default) or `local`/`sandbox`. `mainnet` is refused. |
| `OPENLID_CONTRACT_ID` | Treasury contract. Also the 1Click `recipient`. |
| `OPENLID_USDC_TOKEN_ID` | NEP-141 USDC account; 1Click `destinationAsset` is `nep141:<this>`. |
| `OPENLID_AGENT_ACCOUNT_ID` | Account that owns the agent's function-call key. |
| `OPENLID_AGENT_KEY_FILE` | **Path** to the agent key file (see below). Never the key itself. |
| `OPENLID_OWNER_ACCOUNT_ID` | Treasurer account, only for demo approve/reject. |
| `OPENLID_OWNER_KEY_FILE` | Optional path to a demo owner key. Leave it unset if the treasurer signs with their own wallet. |
| `ONECLICK_BASE_URL` | Default `https://1click.chaindefuser.com`. |
| `ONECLICK_API_KEY` | Sent as the `X-API-Key` header. Never logged or returned. |
| `OPENLID_DATA_DIR` | Where `gifts.json` / `payouts.json` are stored (default `./data`, gitignored). |
| `OPENLID_API_HOST`, `OPENLID_API_PORT` | Bind address, default `127.0.0.1` / `8787`. |

If the contract, agent account, or agent key file is missing, the gift endpoints still work. Payout and hold endpoints return `503`, and `/api/summary` reports `holds.available: false`.

### Agent key: restricted function-call key only

`POST /api/payouts/request` signs `request_payout` with the key at `OPENLID_AGENT_KEY_FILE`. That key **must be a NEAR function-call access key** restricted to `receiver_id = OPENLID_CONTRACT_ID` and `method_names = ["request_payout"]`. Before the first use, the API looks up the key on-chain with `view_access_key`. It **refuses full-access keys**, and keys scoped to any other contract or method. A function-call key can't move funds directly, so the agent can only *ask* the contract to pay. The contract enforces the allowlist, per-bill limit, monthly cap, and hold path.

You can issue one with NEAR CLI, something like `near account add-key <agent> grant-function-call-access --receiver-account-id <contract> --method-names request_payout ...`. Keep the generated key file outside this repository.

The key file can be a NEAR CLI credentials JSON (`{"account_id","public_key","private_key"}`) or a file containing only the `ed25519:...` string. The contents are never logged.

The agent key is never used for `approve_hold` / `reject_hold`. Those are treasurer (owner) actions, signed only with `OPENLID_OWNER_KEY_FILE` if configured. Otherwise they return `503`, and the treasurer signs from their own wallet.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/gifts/quote` | Validates `donor`, `fund` (`general`/`missions`/`building`), `originAsset`, `amount` (integer string), `refundTo`, optional `refundType` (`ORIGIN_CHAIN`), `slippageTolerance` (bps, default 100). Calls 1Click `POST /v0/quote` once, then stores one gift keyed by `quote.depositAddress`. Returns `201` with the gift, including `receiptNote`. |
| GET | `/api/gifts[?fund=]` | `{ gifts: Gift[] }`, newest first. |
| GET | `/api/gifts/:id` | One gift. |
| POST | `/api/gifts/:id/sync` | Calls 1Click `GET /v0/status?depositAddress=…[&depositMemo=…]` for this gift's address, then maps and stores the status. |
| POST | `/api/payouts/request` | `{ vendor, amount, billId, memo }` → `{ billId, status: "paid"|"held", vendor, amount }`. A contract panic returns `422 { error }`. |
| GET | `/api/payouts` | `{ payouts: PayoutView[] }`, paid payouts submitted through this API. |
| GET | `/api/holds[?status=held|approved|rejected]` | `{ holds: HoldView[] }` from contract `list_holds`. |
| POST | `/api/holds/:billId/approve`, `/reject` | Treasurer path (owner key). |
| GET | `/api/summary` | Settled gifts by fund, paid payouts, outstanding holds, `receiptNote`. |
| GET | `/api/export.csv` | First line `# demo, not a tax document`, then one table with a `type` column (`gift` / `payout`). Cells starting with `= + - @` are prefixed with `'` so spreadsheets don't run them as formulas. |

Status mapping: `PENDING_DEPOSIT`→`pending_deposit`; `KNOWN_DEPOSIT_TX`, `PROCESSING`, `INCOMPLETE_DEPOSIT`→`processing`; `SUCCESS`→`settled`; `REFUNDED`→`refunded`; `FAILED`→`failed`.

Errors are always `{ "error": "..." }`: `400` validation, `404` not found, `409` reused deposit address or duplicate `billId`, `422` contract rejection, `502` 1Click failure, `503` not configured.

## Gift rules

- One 1Click quote and one deposit address per gift. If 1Click ever returns an address already assigned to a gift (compared case-insensitively), the quote is rejected with `409` and no gift is created.
- Status is only ever looked up by the gift's own `depositAddress` (plus `depositMemo` when present). If the status response echoes a different address, it is rejected. Gifts are **never** matched by amount.
- `failed` and `refunded` are terminal statuses in their own right. They are never folded into pending.
- Responses never include the donor's `refundTo` address, the 1Click quote signature, or any key material.

## How tests mock 1Click and NEAR

- **1Click:** tests use the production `HttpOneClickClient` with an injected `fetch` (`MockOneClick` in `test/helpers.ts`). The mock serves `/v0/quote` from a queue of deposit addresses, and `/v0/status` from a map keyed by deposit address. It records each request, so tests check the exact quote body, the `X-API-Key` header, and the `depositAddress`/`depositMemo` query. No network calls are made.
- **NEAR:** tests inject `FakeTreasury`, an in-memory `NearContractClient` that follows the contract policy in `INTERFACES.md` (allowlist, per-bill limit → hold, monthly cap, duplicate `bill_id`). Panics are thrown as `ContractRejectedError`. No key file is needed. The key-file loader test writes a dummy placeholder string to a temp dir.
- Each test uses a fresh temp `OPENLID_DATA_DIR`.

## Known limitations

- `GET /api/payouts` lists payouts submitted through this API instance. The contract has no "list payouts" view, so payouts made by other clients don't show up.
- The JSON store is meant for a single API process.
- The production `NearRpcContractClient` (near-api-js) typechecks, but it has not been run against testnet in this tree. After `request_payout`, it reads `get_payout` / `get_hold` back to decide `paid` vs `held`.
