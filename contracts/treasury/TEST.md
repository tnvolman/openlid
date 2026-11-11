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

## near-workspaces

Not used. No sandbox (near-workspaces) integration test was written or run, so
end-to-end behaviour against a real NEP-141 token contract is untested here.
