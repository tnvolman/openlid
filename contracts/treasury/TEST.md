# Treasury tests

Command:

```sh
cd contracts/treasury
cargo test
```

All tests are near-sdk unit tests (`src/tests.rs`, `src/policy.rs`) running on
the mocked runtime. Time is advanced by re-creating the mocked context with a
later `block_timestamp`.

USDC transfers are not executed in unit tests (the mocked runtime has no other
contracts). Instead the tests inspect the receipts the contract creates and
assert there is exactly one `ft_transfer` to `usdc.near` with the expected
`receiver_id`, `amount`, and 1 yoctoNEAR attached — or none, for holds and
rejections. The failure callback is tested by injecting a failed promise result.

| Required case | Tests |
| --- | --- |
| Per-bill limit: at limit paid, above limit held | `per_bill_limit_at_limit_is_paid`, `per_bill_limit_above_limit_is_held` |
| Monthly cap: would-exceed panics; after cap hit panics | `monthly_cap_payment_that_would_exceed_panics`, `monthly_cap_payment_after_cap_hit_panics` (also `monthly_cap_resets_next_calendar_month`) |
| Allowlist: unknown vendor panics; after add executed, payout succeeds | `allowlist_unknown_vendor_panics`, `allowlist_after_add_executed_payout_succeeds`, `allowlist_removed_vendor_panics` |
| 24h delay: early execute panics; after 24h succeeds | `delay_execute_before_24h_panics`, `delay_execute_after_24h_succeeds`, `delay_replacing_proposal_restarts_clock` |
| Hold + treasurer approve / reject | `hold_approve_transfers_and_marks_approved`, `hold_reject_does_not_transfer`, `hold_approve_rechecks_cap` |
| Unauthorized callers | `unauthorized_non_agent_request_payout`, `unauthorized_non_owner_approve_hold`, `unauthorized_non_owner_propose_allowlist_change` (plus reject_hold, set_limits, callback) |
| Fund validation | `fund_invalid_on_request_payout_panics`, `fund_invalid_on_credit_fund_panics`, `fund_invalid_on_get_fund_panics` |
| Insufficient fund: auto-pay and hold creation refused | `fund_insufficient_refuses_auto_pay`, `fund_cannot_pay_from_another_funds_gift`, `fund_insufficient_refuses_hold_creation`, `fund_exact_balance_pays_and_holds` |
| Holds reserve available (B4); second over-committing hold refused immediately | `fund_hold_reserves_available`, `fund_second_hold_that_would_overcommit_is_refused_immediately`, `fund_auto_pay_cannot_spend_reserved_hold_money` |
| `approve_hold` converts held to paid and re-checks the fund | `fund_approve_converts_held_to_paid`, `fund_approve_hold_rechecks_fund_defensively` |
| Restriction labels; general cannot pay another fund's bill | `fund_restriction_labels`, `fund_general_cannot_pay_a_missions_bill` |
| `credit_fund`: owner only, unique `gift_id`, args | `credit_fund_rejects_agent`, `credit_fund_rejects_stranger`, `credit_fund_duplicate_gift_id_panics`, `credit_fund_seed_gift_id_is_taken`, `credit_fund_zero_amount_panics`, `credit_fund_empty_gift_id_panics` |
| Ledger math (received / paid / held / available = received - paid - held) | `fund_ledger_math_received_paid_available_held`, `fund_reject_hold_frees_reservation` |
| Views and events carry `fund` | `fund_list_holds_and_payout_view_include_fund`, `fund_exact_balance_pays_and_holds`, `per_bill_limit_at_limit_is_paid`, `per_bill_limit_above_limit_is_held` |
| Transfer rollback restores fund `paid` (and the hold's reservation) | `fund_failed_direct_transfer_restores_paid`, `fund_failed_hold_transfer_restores_paid_and_held` |

The test helper `init()` credits `general` with 50,000 USDC (`seed-gift`) so
the limit / cap / allowlist tests are not blocked by fund balance;
`init_unfunded()` starts with empty ledgers for the fund tests.

## near-workspaces

Not used. No sandbox (near-workspaces) integration test was written or run, so
end-to-end behaviour against a real NEP-141 token contract is untested here.

One manual testnet run against the `tUSDC` test FT is recorded in
[`TESTNET-PROOF.md`](TESTNET-PROOF.md): a `building` bill refused with
`insufficient fund balance`, and a `missions` bill paid by `ft_transfer`.

## Testnet token

Unit tests use the placeholder token id `usdc.near`. The testnet demo uses the
`tUSDC` test FT from `contracts/test-ft` (tested separately with
`cd contracts/test-ft && cargo test`), never mainnet USDC, and never sends a
1Click deposit.
