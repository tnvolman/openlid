# OpenLid treasury contract

Rust `near-sdk` 5 contract that holds USDC (NEP-141) for a church and enforces
payout policy on-chain: per-bill limit, calendar-month (UTC) cap, vendor
allowlist with a 24 hour change delay, treasurer holds for bills over the
per-bill limit, and per-fund balances (`general`, `missions`, `building`): a
bill is paid only from its own fund's uncommitted
`available = received - paid - held`, and outstanding holds reserve their
amount. `missions` and `building` are labelled *with donor restrictions* and
`general` *without donor restrictions* (current US GAAP wording); the label
does not let `general` pay other funds' bills. All three are siloed. The
interface (methods, args, views, events) is defined in
[`INTERFACES.md`](../../INTERFACES.md) and implemented as written.

## Testnet demo: settlement uses a test FT

The OpenLid demo runs on NEAR **testnet only**, with $0 spend. In the demo,
`usdc_token` points at the testnet test FT in [`../test-ft`](../test-ft)
(`tUSDC`, 6 decimals), **not mainnet USDC**. Gift "settlement" is simulated by
minting `tUSDC` into this treasury contract and then calling `credit_fund` for
the gift's fund. 1Click is only
called with dry-run quotes; no 1Click deposit is ever sent and no cross-chain
transfer happens. Treasury policy (limits, cap, allowlist, holds) runs for real
on testnet against that token.

## Test

```sh
cd contracts/treasury
cargo test
```

Unit tests run against near-sdk's mocked runtime (`unit-testing` feature). See
[`TEST.md`](TEST.md) for what is covered and how token transfers are checked.

## Build

```sh
cd contracts/treasury
cargo build --target wasm32-unknown-unknown --release
# -> target/wasm32-unknown-unknown/release/openlid_treasury.wasm
```

For a deployable artifact, prefer `cargo near build` (cargo-near), which pins a
NEAR-compatible wasm feature set and runs `wasm-opt`. Recent rustc versions emit
wasm features that some nearcore versions reject; the plain cargo build above is
only verified to compile. Nothing here has been deployed.

## Layout

- `src/lib.rs` — contract state, change methods, views, NEP-297 events.
- `src/policy.rs` — pure policy decisions (`decide_payout`, `fits_cap`) and
  UTC `YYYY-MM` month calculation, unit tested on their own.
- `src/tests.rs` — contract unit tests.

## Implementation notes

- `request_payout` returns `"held"` for a hold. For a payment it returns the
  `ft_transfer` promise chained to a private callback `on_payout_transfer`,
  whose result is `"paid"`. If the token contract rejects the transfer, the
  callback rolls back the payout record, cap usage and fund `paid` (and returns an approved
  hold to `held`), logs a plain message, and resolves to `"transfer_failed"`.
  `approve_hold` behaves the same way. `on_payout_transfer` is an internal
  callback (callable only by the contract itself), not part of the public API.
- `ft_transfer` is called with 1 yoctoNEAR attached from the contract's own
  balance, so the agent's function-call access key needs no deposit. The
  treasury contract account must be registered with the USDC token
  (`storage_deposit`) and each vendor must be registered too, or the transfer
  fails and is rolled back.
- The cap and payout record are updated when the transfer is started, so two
  payouts in the same block cannot both squeeze under the cap.
- A removed vendor stays known but inactive; `request_payout` panics with
  "vendor is not active on the allowlist". `get_allowlist` lists active vendors.
- Holds do not reserve cap. `approve_hold` re-checks the cap at approval time.
- Per-fund ledger: `fund_ledger` maps each fund to `{ received, paid, held }`.
  `credit_fund(fund, amount, gift_id)` (owner only) adds to `received` and
  moves no tokens; `credited_gifts` rejects a second credit for the same
  `gift_id`. `request_payout` takes a required `fund` and refuses a bill (paid
  or held) over the fund's uncommitted `available = received - paid - held`
  with "insufficient fund balance: ...", so a second hold cannot over-commit
  the same money. A new hold adds to `held`; `approve_hold` re-checks
  (defensively) and converts `held` to `paid`; `reject_hold` releases the
  reservation. The `on_payout_transfer` rollback subtracts `paid` and, for an
  approved hold, puts the reservation back in `held`.
- `fund_restriction(fund)` / `FundView.restriction`: `general` is "without
  donor restrictions"; `missions` and `building` are "with donor
  restrictions". Label only: there is no interfund transfer, so `general`
  cannot pay a missions or building bill.
- Breaking change: `Payout`/`Hold` gained `fund` and the state gained two
  collections, with no migration. A deployment of the previous version (e.g.
  `treasury.openlid-demo-mwbp9t7m.testnet`) needs a fresh account and
  redeploy; see INTERFACES.md.
- Timestamps (`execute_after`) are `U64` strings in JSON; amounts are `U128`
  strings. Events use `EVENT_JSON:` with `standard: "openlid"`,
  `version: "1.0.0"`, and `data` as a one-element array.
- Account ids in tests are placeholders (`owner.near`, `agent.near`,
  `vendor.near`, `usdc.near`). No keys are used or stored.
