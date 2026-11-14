# Testnet proof: per-fund treasury

**NEAR testnet only. Test tokens (tUSDC) only. No real funds.**

Date: Fri Nov 13 2026, about 9:05 to 9:15 PM ET. Network: NEAR **testnet**.

This deploys the current per-fund treasury build (the one that has `get_fund_ledger` and `credit_fund`) and shows the contract refusing a bill that its fund cannot cover.

## Accounts

| Role | Account |
| --- | --- |
| Root (church owner / treasurer in the demo) | `openlid-demo-mwfrrslq.testnet` |
| Treasury contract | `treasury.openlid-demo-mwfrrslq.testnet` |
| Test token (tUSDC, 6 decimals) | `tusdc.openlid-demo-mwfrrslq.testnet` |
| Agent (one function-call key, `request_payout` on the treasury only) | `agent.openlid-demo-mwfrrslq.testnet` |
| Vendor (initial allowlist) | `vendor.openlid-demo-mwfrrslq.testnet` |

The older testnet treasury `treasury.openlid-demo-mwbp9t7m.testnet` runs the earlier build (allowlist, limits, holds, timelock) without per-fund balances. On that account, `get_fund_ledger` returns `MethodNotFound`.

**Funding.** The testnet faucet was rate-limited (HTTP 429), so the root account was created through the `testnet` registrar (`create_account`). It was funded with testnet NEAR from the owner's other testnet accounts. Then `scripts/testnet/setup.mjs` created the sub-accounts and deployed both contracts. It made no faucet calls.

## Wasm

Built with `cargo near build non-reproducible-wasm --locked --no-abi` (cargo-near 0.23.0) in each contract directory. The output is in `target/near/`.

| Contract | sha256 (hex) | On-chain `code_hash` (base58 of the same sha256) |
| --- | --- | --- |
| `contracts/treasury` → `openlid_treasury.wasm` (206,185 bytes) | `9b8810382ba051e5332b0a814c1d6642c9c40ca4123f3fe0cd4743c9b078ba8a` | `BU8Xe7wZNpuT2N3A9phxAC1xXb48kW7PVm9kbf3zPZQM` |
| `contracts/test-ft` → `openlid_test_ft.wasm` (151,163 bytes) | `f934d79bcbb6197e4f9dee80e40acc5a1bb8d6fbae2101f5f07a6f3455b8cdfc` | `HmoFYFroGWVmcHvmPC9U7g4uzHhHECvEkJCTyhA2f9hm` |

The `code_hash` values come from `view_account` on public RPC (`https://rpc.testnet.fastnear.com`), and each matches the local build. The non-reproducible build means a rebuild on another machine may not give the same hash.

## Setup transactions

Each of these was checked with `EXPERIMENTAL_tx_status`. All succeeded.

| Step | Transaction |
| --- | --- |
| Create root via `testnet` registrar | <https://testnet.nearblocks.io/txns/3J5HwVFsxdPwRaexw5PPDKsvGi55gZgCNThV3Xvgph4d> |
| Create `agent.*` | <https://testnet.nearblocks.io/txns/7QPqdH4zZyYXcvbYoGZXAcEeLxJmugeECSB2wHMCJjbA> |
| Create `vendor.*` | <https://testnet.nearblocks.io/txns/3wzLjUCTHsWvhyVifDAkZdbBQF2c7TZvkysNhzihw8wq> |
| Create `treasury.*` | <https://testnet.nearblocks.io/txns/A4eUbxtP8UNGHy2kE291sob7Um9jY6SsXhC3phVByUU4> |
| Create `tusdc.*` | <https://testnet.nearblocks.io/txns/Gk594vMFXzRSR7sCNkLgcoXgWQ2yvo6VE1oMmuCuvhed> |
| Deploy test FT | <https://testnet.nearblocks.io/txns/A7DU1FyWSXNFNXEUyqCMdcvCeE3L7tJksSFZGe6koQb2> |
| Deploy treasury | <https://testnet.nearblocks.io/txns/A6eGthSvnpgyrHzsdAGcZF4NjYt5Pjc47zFGvQsYJ1s8> |

`setup.mjs` does not print hashes for the init calls (`new` on both contracts), the storage deposits, or the agent key swap. They are checked by state instead:
- `get_config` returns owner `openlid-demo-mwfrrslq.testnet`, agent `agent.openlid-demo-mwfrrslq.testnet`, token `tusdc.openlid-demo-mwfrrslq.testnet`, `per_bill_limit` 100000000 (100 tUSDC), and `monthly_cap` 10000000000.
- `get_allowlist` returns `["vendor.openlid-demo-mwfrrslq.testnet"]`.
- The agent account's only access key is a `FunctionCall` key for `request_payout` on the treasury.

## Per-fund refusal

Run with `OPENLID_NETWORK=testnet node scripts/testnet/prove-fund-refusal.mjs`. Every fund started at 0.

| # | Signer → method | Result (from `EXPERIMENTAL_tx_status`) | Transaction |
| --- | --- | --- | --- |
| 1 | owner → `tusdc.mint(treasury, 100000000)` | Success. The treasury holds 100 tUSDC. | <https://testnet.nearblocks.io/txns/6PKtuic5H3eKdRX6cV25nBBHdggF95EK6qaooczCdqTT> |
| 2 | owner → `treasury.credit_fund("missions", 100000000, …)` | Success. `fund_credited` event: missions received 100 tUSDC. | <https://testnet.nearblocks.io/txns/Aj4xcbRTBxQmwmA3JHTpiggdwUzXP9ahYNYuPq1MJNeW> |
| 3 | agent → `treasury.request_payout(vendor, 50000000, fund "building")` | **Failure:** `Smart contract panicked: insufficient fund balance: building has 0 available, bill needs 50000000` | <https://testnet.nearblocks.io/txns/4B2XGrQoBFYyWFqmyivTRg7GDDMJMXJdV2NXa5nEi1Kw> |
| 4 | agent → `treasury.request_payout(vendor, 40000000, fund "missions")` | Success. Returns `"paid"` (`ft_transfer` of 40 tUSDC to the vendor). | <https://testnet.nearblocks.io/txns/3KkipkFteWrfrwwHZ6DfWoHLgXhKnQ6sPB2GusdQm18A> |

In step 3, the treasury held 100 tUSDC, and the bill was under the 100 tUSDC per-bill limit and to an allowlisted vendor. The contract still refused it, because it was tagged `building` and the building ledger had 0 available.

`get_fund_ledger` afterwards:

| Fund | Restriction | Received | Paid | Held | Available |
| --- | --- | --- | --- | --- | --- |
| general | without donor restrictions | 0 | 0 | 0 | 0 |
| missions | with donor restrictions | 100000000 | 40000000 | 0 | 60000000 |
| building | with donor restrictions | 0 | 0 | 0 | 0 |

Token balances: the vendor has 40000000 and the treasury has 60000000. These match the ledgers.

## What this does not show

- The ledger credit in step 2 is a number the owner enters. The contract does not check it against tokens received (see `credit_fund` and the README's Known issues).
- In this demo, the treasury account still has a full-access key in the gitignored `.demo-keys/`. That key could move tokens with `ft_transfer` directly or deploy new code, bypassing every rule above. A real deployment must delete it.
- There are no `near-workspaces` sandbox tests. This proof is one run on testnet. Contract coverage is otherwise the `near-sdk` unit tests (`cargo test`).
