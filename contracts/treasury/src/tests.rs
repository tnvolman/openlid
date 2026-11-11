//! Unit tests against the mocked NEAR runtime. USDC transfers are verified by
//! inspecting the `ft_transfer` receipts the contract creates (the mocked
//! runtime records receipts instead of executing them).
//!
//! Results of `request_payout` / `approve_hold` are often dropped on purpose:
//! dropping a `Promise` schedules it, just as returning it does on-chain.
#![allow(unused_must_use)]

use super::*;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const LIMIT: u128 = 1_000_000_000; // 1,000 USDC
const CAP: u128 = 5_000_000_000; // 5,000 USDC
/// 2026-11-15T12:00:00Z
const NOV_15: u64 = 1_794_744_000 * 1_000_000_000;
/// 2026-12-01T00:00:00Z
const DEC_1: u64 = 1_796_083_200 * 1_000_000_000;

fn owner() -> AccountId {
    "owner.near".parse().unwrap()
}
fn agent() -> AccountId {
    "agent.near".parse().unwrap()
}
fn vendor() -> AccountId {
    "vendor.near".parse().unwrap()
}
fn usdc() -> AccountId {
    "usdc.near".parse().unwrap()
}
fn treasury_id() -> AccountId {
    "treasury.near".parse().unwrap()
}
fn stranger() -> AccountId {
    "stranger.near".parse().unwrap()
}

/// Starts a fresh mocked block (storage carried over, receipts and logs reset).
fn ctx(caller: AccountId, now: u64) {
    let context = VMContextBuilder::new()
        .current_account_id(treasury_id())
        .predecessor_account_id(caller.clone())
        .signer_account_id(caller)
        .block_timestamp(now)
        .build();
    testing_env!(context);
}

fn init() -> Treasury {
    ctx(owner(), NOV_15);
    Treasury::new(owner(), agent(), usdc(), U128(LIMIT), U128(CAP), vec![])
}

/// Contract with `vendor.near` already allowlisted (proposal + 24h + execute).
fn init_with_vendor() -> Treasury {
    let mut c = init();
    c.propose_allowlist_change(vendor(), "add".into());
    ctx(stranger(), NOV_15 + ALLOWLIST_DELAY_NS);
    c.execute_allowlist_change(vendor());
    c
}

fn request(c: &mut Treasury, amount: u128, bill_id: &str) -> PromiseOrValue<String> {
    ctx(agent(), NOV_15 + ALLOWLIST_DELAY_NS);
    c.request_payout(vendor(), U128(amount), bill_id.into(), format!("memo {bill_id}"))
}

/// (token contract, receiver, amount, attached deposit) for every ft_transfer
/// receipt created in the current mocked block.
fn ft_transfers() -> Vec<(AccountId, AccountId, u128, NearToken)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let token = r.receiver_id.clone();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. }
                    if method_name == b"ft_transfer" =>
                {
                    let v: serde_json::Value = serde_json::from_slice(&args).unwrap();
                    Some((
                        token.clone(),
                        v["receiver_id"].as_str().unwrap().parse().unwrap(),
                        v["amount"].as_str().unwrap().parse().unwrap(),
                        attached_deposit,
                    ))
                }
                _ => None,
            })
        })
        .collect()
}

fn events() -> Vec<serde_json::Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str(j).unwrap())
        .collect()
}

fn event_names() -> Vec<String> {
    events().iter().map(|e| e["event"].as_str().unwrap().to_string()).collect()
}

// ---------- init ----------

#[test]
fn init_sets_config() {
    let c = init();
    assert_eq!(
        c.get_config(),
        ConfigView {
            owner: owner(),
            agent: agent(),
            usdc_token: usdc(),
            per_bill_limit: U128(LIMIT),
            monthly_cap: U128(CAP),
        }
    );
    assert_eq!(
        c.get_month_spent(),
        MonthSpentView { year_month: "2026-11".into(), spent: U128(0), cap: U128(CAP) }
    );
    assert!(c.get_allowlist().is_empty());
}

#[test]
#[should_panic(expected = "owner and agent must differ")]
fn init_rejects_owner_equal_agent() {
    ctx(owner(), NOV_15);
    Treasury::new(owner(), owner(), usdc(), U128(LIMIT), U128(CAP), vec![]);
}

#[test]
#[should_panic(expected = "per_bill_limit must be > 0")]
fn init_rejects_zero_limit() {
    ctx(owner(), NOV_15);
    Treasury::new(owner(), agent(), usdc(), U128(0), U128(CAP), vec![]);
}

#[test]
#[should_panic(expected = "monthly_cap must be > 0")]
fn init_rejects_zero_cap() {
    ctx(owner(), NOV_15);
    Treasury::new(owner(), agent(), usdc(), U128(LIMIT), U128(0), vec![]);
}

// ---------- 1. per-bill limit ----------

#[test]
fn per_bill_limit_at_limit_is_paid() {
    let mut c = init_with_vendor();
    let out = request(&mut c, LIMIT, "bill-1");
    assert!(matches!(out, PromiseOrValue::Promise(_)));
    drop(out); // a dropped Promise is scheduled, as when returned on-chain

    assert_eq!(ft_transfers(), vec![(usdc(), vendor(), LIMIT, ONE_YOCTO)]);
    assert_eq!(
        c.get_payout("bill-1".into()),
        Some(PayoutView {
            bill_id: "bill-1".into(),
            vendor: vendor(),
            amount: U128(LIMIT),
            memo: "memo bill-1".into(),
            status: "paid".into(),
        })
    );
    assert_eq!(c.get_hold("bill-1".into()), None);
    assert_eq!(c.get_month_spent().spent, U128(LIMIT));
    assert_eq!(event_names(), vec!["payout_requested"]);
}

#[test]
fn per_bill_limit_above_limit_is_held() {
    let mut c = init_with_vendor();
    let out = request(&mut c, LIMIT + 1, "bill-big");
    assert!(matches!(out, PromiseOrValue::Value(ref s) if s == "held"));

    assert!(ft_transfers().is_empty(), "held bill must not transfer");
    assert_eq!(c.get_payout("bill-big".into()), None);
    assert_eq!(
        c.get_hold("bill-big".into()),
        Some(HoldView {
            bill_id: "bill-big".into(),
            vendor: vendor(),
            amount: U128(LIMIT + 1),
            memo: "memo bill-big".into(),
            status: "held".into(),
        })
    );
    assert_eq!(c.get_month_spent().spent, U128(0), "hold does not consume cap");
    let ev = events();
    assert_eq!(event_names(), vec!["payout_requested", "payout_held"]);
    assert_eq!(ev[1]["data"][0]["reason"], "over_per_bill_limit");
    assert_eq!(ev[1]["data"][0]["amount"], (LIMIT + 1).to_string());
}

// ---------- 2. monthly cap ----------

#[test]
#[should_panic(expected = "monthly cap exceeded")]
fn monthly_cap_payment_that_would_exceed_panics() {
    let mut c = init_with_vendor();
    for i in 0..4 {
        request(&mut c, LIMIT, &format!("b{i}"));
    }
    assert_eq!(c.get_month_spent().spent, U128(4 * LIMIT));
    // 4,000 spent; 1,000.000001 more would exceed 5,000 (and is over-limit, so
    // even the hold path is refused).
    request(&mut c, LIMIT + 1, "too-much");
}

#[test]
#[should_panic(expected = "monthly cap exceeded")]
fn monthly_cap_payment_after_cap_hit_panics() {
    let mut c = init_with_vendor();
    for i in 0..5 {
        request(&mut c, LIMIT, &format!("b{i}"));
    }
    assert_eq!(c.get_month_spent().spent, U128(CAP));
    request(&mut c, 1, "one-more");
}

#[test]
fn monthly_cap_resets_next_calendar_month() {
    let mut c = init_with_vendor();
    for i in 0..5 {
        request(&mut c, LIMIT, &format!("b{i}"));
    }
    ctx(agent(), DEC_1);
    assert_eq!(
        c.get_month_spent(),
        MonthSpentView { year_month: "2026-12".into(), spent: U128(0), cap: U128(CAP) }
    );
    c.request_payout(vendor(), U128(LIMIT), "dec-1".into(), "".into());
    assert_eq!(ft_transfers().len(), 1);
    assert_eq!(c.get_month_spent().spent, U128(LIMIT));
}

#[test]
fn set_limits_owner_only_and_immediate() {
    let mut c = init_with_vendor();
    request(&mut c, LIMIT, "b0");
    ctx(owner(), NOV_15 + ALLOWLIST_DELAY_NS);
    c.set_limits(U128(2 * LIMIT), U128(10 * LIMIT));
    assert_eq!(event_names(), vec!["limits_updated"]);
    assert_eq!(c.get_config().per_bill_limit, U128(2 * LIMIT));
    assert_eq!(c.get_month_spent().spent, U128(LIMIT), "month_spent unchanged");
    // 2,000 is now under the per-bill limit, so it pays immediately.
    let out = request(&mut c, 2 * LIMIT, "b1");
    assert!(matches!(out, PromiseOrValue::Promise(_)));
}

#[test]
#[should_panic(expected = "unauthorized: caller is not owner")]
fn set_limits_rejects_non_owner() {
    let mut c = init();
    ctx(agent(), NOV_15);
    c.set_limits(U128(1), U128(1));
}

#[test]
#[should_panic(expected = "monthly_cap must be > 0")]
fn set_limits_rejects_zero() {
    let mut c = init();
    ctx(owner(), NOV_15);
    c.set_limits(U128(1), U128(0));
}

// ---------- 3. allowlist ----------

#[test]
#[should_panic(expected = "vendor is not on the allowlist")]
fn allowlist_unknown_vendor_panics() {
    let mut c = init();
    request(&mut c, 1, "bill-1");
}

#[test]
fn allowlist_after_add_executed_payout_succeeds() {
    let mut c = init();
    c.propose_allowlist_change(vendor(), "add".into());
    ctx(stranger(), NOV_15 + ALLOWLIST_DELAY_NS);
    c.execute_allowlist_change(vendor());
    assert_eq!(c.get_allowlist(), vec![vendor()]);
    assert_eq!(c.get_proposal(vendor()), None);

    request(&mut c, 10, "bill-1");
    assert_eq!(ft_transfers(), vec![(usdc(), vendor(), 10, ONE_YOCTO)]);
}

#[test]
#[should_panic(expected = "vendor is not active on the allowlist")]
fn allowlist_removed_vendor_panics() {
    let mut c = init_with_vendor();
    ctx(owner(), NOV_15 + ALLOWLIST_DELAY_NS);
    c.propose_allowlist_change(vendor(), "remove".into());
    ctx(stranger(), NOV_15 + 2 * ALLOWLIST_DELAY_NS);
    c.execute_allowlist_change(vendor());
    assert!(c.get_allowlist().is_empty());
    ctx(agent(), NOV_15 + 2 * ALLOWLIST_DELAY_NS);
    c.request_payout(vendor(), U128(1), "bill-1".into(), "".into());
}

#[test]
#[should_panic(expected = "action must be add or remove")]
fn allowlist_rejects_bad_action() {
    let mut c = init();
    c.propose_allowlist_change(vendor(), "enable".into());
}

// ---------- 4. 24h delay ----------

#[test]
#[should_panic(expected = "allowlist change delay has not passed")]
fn delay_execute_before_24h_panics() {
    let mut c = init();
    c.propose_allowlist_change(vendor(), "add".into());
    ctx(stranger(), NOV_15 + ALLOWLIST_DELAY_NS - 1);
    c.execute_allowlist_change(vendor());
}

#[test]
fn delay_execute_after_24h_succeeds() {
    let mut c = init();
    c.propose_allowlist_change(vendor(), "add".into());
    let ev = events();
    assert_eq!(ev[0]["event"], "allowlist_proposed");
    assert_eq!(ev[0]["standard"], "openlid");
    assert_eq!(ev[0]["version"], "1.0.0");
    assert_eq!(ev[0]["data"][0]["execute_after"], (NOV_15 + ALLOWLIST_DELAY_NS).to_string());
    assert_eq!(
        c.get_proposal(vendor()),
        Some(AllowlistProposalView {
            vendor: vendor(),
            action: "add".into(),
            execute_after: U64(NOV_15 + ALLOWLIST_DELAY_NS),
        })
    );

    ctx(stranger(), NOV_15 + ALLOWLIST_DELAY_NS);
    c.execute_allowlist_change(vendor());
    assert_eq!(c.get_allowlist(), vec![vendor()]);
    assert_eq!(event_names(), vec!["allowlist_executed"]);
    assert_eq!(events()[0]["data"][0]["action"], "add");
}

#[test]
#[should_panic(expected = "status must be held, approved, or rejected")]
fn list_holds_rejects_bad_status() {
    let c = init();
    c.list_holds(Some("paid".into()));
}

#[test]
#[should_panic(expected = "allowlist change delay has not passed")]
fn delay_replacing_proposal_restarts_clock() {
    let mut c = init();
    c.propose_allowlist_change(vendor(), "add".into());
    ctx(owner(), NOV_15 + 1_000);
    c.propose_allowlist_change(vendor(), "add".into());
    ctx(stranger(), NOV_15 + ALLOWLIST_DELAY_NS);
    c.execute_allowlist_change(vendor());
}

#[test]
#[should_panic(expected = "no pending allowlist proposal for vendor")]
fn delay_execute_without_proposal_panics() {
    let mut c = init();
    ctx(stranger(), NOV_15 + ALLOWLIST_DELAY_NS);
    c.execute_allowlist_change(vendor());
}

// ---------- 5. hold + treasurer approve / reject ----------

#[test]
fn hold_approve_transfers_and_marks_approved() {
    let mut c = init_with_vendor();
    request(&mut c, 3 * LIMIT, "unusual");
    assert!(ft_transfers().is_empty());
    assert_eq!(c.list_holds(Some("held".into())).len(), 1);

    ctx(owner(), NOV_15 + ALLOWLIST_DELAY_NS);
    c.approve_hold("unusual".into());
    assert_eq!(ft_transfers(), vec![(usdc(), vendor(), 3 * LIMIT, ONE_YOCTO)]);
    assert_eq!(c.get_hold("unusual".into()).unwrap().status, "approved");
    assert_eq!(c.get_payout("unusual".into()).unwrap().status, "paid");
    assert_eq!(c.get_month_spent().spent, U128(3 * LIMIT));
    assert_eq!(event_names(), vec!["hold_approved"]);
    assert!(c.list_holds(Some("held".into())).is_empty());
    assert_eq!(c.list_holds(Some("approved".into())).len(), 1);
    assert_eq!(c.list_holds(None).len(), 1);
}

#[test]
fn hold_reject_does_not_transfer() {
    let mut c = init_with_vendor();
    request(&mut c, 3 * LIMIT, "unusual");
    ctx(owner(), NOV_15 + ALLOWLIST_DELAY_NS);
    c.reject_hold("unusual".into());
    assert!(ft_transfers().is_empty(), "reject must not transfer");
    assert!(get_created_receipts().is_empty());
    assert_eq!(c.get_hold("unusual".into()).unwrap().status, "rejected");
    assert_eq!(c.get_payout("unusual".into()), None);
    assert_eq!(c.get_month_spent().spent, U128(0), "reject does not consume cap");
    assert_eq!(event_names(), vec!["hold_rejected"]);
    assert_eq!(c.list_holds(Some("rejected".into())).len(), 1);
}

#[test]
#[should_panic(expected = "monthly cap exceeded")]
fn hold_approve_rechecks_cap() {
    let mut c = init_with_vendor();
    request(&mut c, 3 * LIMIT, "unusual");
    for i in 0..3 {
        request(&mut c, LIMIT, &format!("b{i}"));
    }
    // 3,000 spent; approving 3,000 more would exceed the 5,000 cap.
    ctx(owner(), NOV_15 + ALLOWLIST_DELAY_NS);
    c.approve_hold("unusual".into());
}

#[test]
#[should_panic(expected = "hold is not held")]
fn hold_cannot_be_approved_twice() {
    let mut c = init_with_vendor();
    request(&mut c, 3 * LIMIT, "unusual");
    ctx(owner(), NOV_15 + ALLOWLIST_DELAY_NS);
    c.reject_hold("unusual".into());
    c.approve_hold("unusual".into());
}

#[test]
fn failed_transfer_rolls_back_payout_and_cap() {
    let mut c = init_with_vendor();
    request(&mut c, 3 * LIMIT, "unusual");
    ctx(owner(), NOV_15 + ALLOWLIST_DELAY_NS);
    c.approve_hold("unusual".into());
    assert_eq!(c.get_month_spent().spent, U128(3 * LIMIT));

    let context = VMContextBuilder::new()
        .current_account_id(treasury_id())
        .predecessor_account_id(treasury_id())
        .block_timestamp(NOV_15 + ALLOWLIST_DELAY_NS)
        .build();
    testing_env!(
        context,
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed],
    );
    let status = c.on_payout_transfer("unusual".into(), "2026-11".into(), U128(3 * LIMIT), true);
    assert_eq!(status, "transfer_failed");
    assert_eq!(c.get_payout("unusual".into()), None);
    assert_eq!(c.get_hold("unusual".into()).unwrap().status, "held");
    assert_eq!(c.get_month_spent().spent, U128(0));
    assert!(
        !event_names().iter().any(|n| n == "payout_executed"),
        "payout_executed must not fire when the transfer fails"
    );
}

fn run_transfer_callback(c: &mut Treasury, bill_id: &str, amount: u128, from_hold: bool, result: PromiseResult) -> String {
    let context = VMContextBuilder::new()
        .current_account_id(treasury_id())
        .predecessor_account_id(treasury_id())
        .block_timestamp(NOV_15 + ALLOWLIST_DELAY_NS)
        .build();
    testing_env!(
        context,
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result],
    );
    c.on_payout_transfer(bill_id.into(), "2026-11".into(), U128(amount), from_hold)
}

#[test]
fn payout_executed_emitted_only_after_successful_transfer() {
    let mut c = init_with_vendor();
    request(&mut c, LIMIT, "bill-1");
    assert_eq!(event_names(), vec!["payout_requested"]);

    let status = run_transfer_callback(&mut c, "bill-1", LIMIT, false, PromiseResult::Successful(vec![]));
    assert_eq!(status, "paid");
    assert_eq!(c.get_payout("bill-1".into()).unwrap().status, "paid");
    assert_eq!(event_names(), vec!["payout_executed"]);
}

#[test]
fn failed_direct_transfer_does_not_emit_payout_executed() {
    let mut c = init_with_vendor();
    request(&mut c, LIMIT, "bill-1");
    let status = run_transfer_callback(&mut c, "bill-1", LIMIT, false, PromiseResult::Failed);
    assert_eq!(status, "transfer_failed");
    assert_eq!(c.get_payout("bill-1".into()), None);
    assert!(!event_names().iter().any(|n| n == "payout_executed"));
}

#[test]
#[should_panic(expected = "vendor is not active on the allowlist")]
fn hold_approve_rechecks_allowlist() {
    let mut c = init_with_vendor();
    request(&mut c, 3 * LIMIT, "unusual");
    ctx(owner(), NOV_15 + ALLOWLIST_DELAY_NS);
    c.propose_allowlist_change(vendor(), "remove".into());
    ctx(stranger(), NOV_15 + 2 * ALLOWLIST_DELAY_NS);
    c.execute_allowlist_change(vendor());
    ctx(owner(), NOV_15 + 2 * ALLOWLIST_DELAY_NS);
    c.approve_hold("unusual".into());
}

// ---------- request_payout argument checks ----------

#[test]
#[should_panic(expected = "duplicate bill_id")]
fn duplicate_bill_id_panics() {
    let mut c = init_with_vendor();
    request(&mut c, 1, "bill-1");
    request(&mut c, 1, "bill-1");
}

#[test]
#[should_panic(expected = "duplicate bill_id")]
fn duplicate_of_held_bill_id_panics() {
    let mut c = init_with_vendor();
    request(&mut c, 2 * LIMIT, "bill-1");
    request(&mut c, 1, "bill-1");
}

#[test]
#[should_panic(expected = "bill_id must be non-empty")]
fn empty_bill_id_panics() {
    let mut c = init_with_vendor();
    request(&mut c, 1, "");
}

#[test]
#[should_panic(expected = "amount must be > 0")]
fn zero_amount_panics() {
    let mut c = init_with_vendor();
    request(&mut c, 0, "bill-1");
}

// ---------- 6. unauthorized callers ----------

#[test]
#[should_panic(expected = "unauthorized: caller is not agent")]
fn unauthorized_non_agent_request_payout() {
    let mut c = init_with_vendor();
    ctx(owner(), NOV_15 + ALLOWLIST_DELAY_NS);
    c.request_payout(vendor(), U128(1), "bill-1".into(), "".into());
}

#[test]
#[should_panic(expected = "unauthorized: caller is not agent")]
fn unauthorized_stranger_request_payout() {
    let mut c = init_with_vendor();
    ctx(stranger(), NOV_15 + ALLOWLIST_DELAY_NS);
    c.request_payout(vendor(), U128(1), "bill-1".into(), "".into());
}

#[test]
#[should_panic(expected = "unauthorized: caller is not owner")]
fn unauthorized_non_owner_approve_hold() {
    let mut c = init_with_vendor();
    request(&mut c, 2 * LIMIT, "unusual");
    ctx(agent(), NOV_15 + ALLOWLIST_DELAY_NS);
    c.approve_hold("unusual".into());
}

#[test]
#[should_panic(expected = "unauthorized: caller is not owner")]
fn unauthorized_non_owner_reject_hold() {
    let mut c = init_with_vendor();
    request(&mut c, 2 * LIMIT, "unusual");
    ctx(agent(), NOV_15 + ALLOWLIST_DELAY_NS);
    c.reject_hold("unusual".into());
}

#[test]
#[should_panic(expected = "unauthorized: caller is not owner")]
fn unauthorized_non_owner_propose_allowlist_change() {
    let mut c = init();
    ctx(agent(), NOV_15);
    c.propose_allowlist_change(vendor(), "add".into());
}

#[test]
#[should_panic(expected = "on_payout_transfer is private")]
fn unauthorized_external_callback() {
    let mut c = init_with_vendor();
    ctx(agent(), NOV_15);
    c.on_payout_transfer("x".into(), "2026-11".into(), U128(1), false);
}

#[test]
fn initial_allowlist_is_active_immediately() {
    ctx(owner(), NOV_15);
    let mut c = Treasury::new(owner(), agent(), usdc(), U128(LIMIT), U128(CAP), vec![vendor()]);
    assert_eq!(c.get_allowlist(), vec![vendor()]);
    ctx(agent(), NOV_15);
    c.request_payout(vendor(), U128(LIMIT), "init-auto".into(), "from init allowlist".into());
    assert_eq!(c.get_payout("init-auto".into()).unwrap().status, "paid");
    assert_eq!(ft_transfers().len(), 1);
}

#[test]
#[should_panic(expected = "allowlist change delay has not passed")]
fn later_allowlist_add_still_waits_24h() {
    ctx(owner(), NOV_15);
    let other: AccountId = "other-vendor.near".parse().unwrap();
    let mut c = Treasury::new(owner(), agent(), usdc(), U128(LIMIT), U128(CAP), vec![vendor()]);
    c.propose_allowlist_change(other.clone(), "add".into());
    ctx(stranger(), NOV_15);
    c.execute_allowlist_change(other);
}
