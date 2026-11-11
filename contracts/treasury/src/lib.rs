//! OpenLid treasury contract.
//!
//! Unaudited. Testnet only. Not for real funds. Provided as-is.
//!
//! Holds USDC (NEP-141) for a church and pays allowlisted vendors under an
//! on-chain policy: a per-bill limit, a calendar-month (UTC) cap, a vendor
//! allowlist with a 24 hour change delay, and treasurer holds for bills over
//! the per-bill limit. Every bill names a fund (`general`, `missions`,
//! `building`) and can only be paid from that fund's ledger balance, which the
//! owner credits per settled gift with `credit_fund`. See `INTERFACES.md` at
//! the repo root for the contract.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, LookupMap, LookupSet};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue,
};

pub mod policy;

use policy::{year_month_from_ns, PayoutDecision};

/// 24 hours in nanoseconds.
pub const ALLOWLIST_DELAY_NS: u64 = 86_400_000_000_000;

const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_FOR_RESOLVE_TRANSFER: Gas = Gas::from_tgas(10);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

const EVENT_STANDARD: &str = "openlid";
const EVENT_VERSION: &str = "1.0.0";

pub const STATUS_PAID: &str = "paid";
pub const STATUS_HELD: &str = "held";
pub const STATUS_APPROVED: &str = "approved";
pub const STATUS_REJECTED: &str = "rejected";

pub const ACTION_ADD: &str = "add";
pub const ACTION_REMOVE: &str = "remove";

pub const REASON_OVER_PER_BILL_LIMIT: &str = "over_per_bill_limit";

/// The only funds a gift or bill may name.
pub const FUNDS: [&str; 3] = ["general", "missions", "building"];
pub const ERR_INVALID_FUND: &str = "fund must be one of general, missions, building";
pub const ERR_INSUFFICIENT_FUND: &str = "insufficient fund balance";

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Vendors,
    Proposals,
    Payouts,
    Holds,
    FundLedger,
    CreditedGifts,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum AllowlistAction {
    Add,
    Remove,
}

impl AllowlistAction {
    fn parse(action: &str) -> Self {
        match action {
            ACTION_ADD => Self::Add,
            ACTION_REMOVE => Self::Remove,
            _ => env::panic_str("action must be add or remove"),
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            Self::Add => ACTION_ADD,
            Self::Remove => ACTION_REMOVE,
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct AllowlistProposal {
    pub action: AllowlistAction,
    pub execute_after: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Payout {
    pub vendor: AccountId,
    pub amount: u128,
    pub memo: String,
    pub fund: String,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum HoldStatus {
    Held,
    Approved,
    Rejected,
}

impl HoldStatus {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Held => STATUS_HELD,
            Self::Approved => STATUS_APPROVED,
            Self::Rejected => STATUS_REJECTED,
        }
    }

    fn parse(status: &str) -> Self {
        match status {
            STATUS_HELD => Self::Held,
            STATUS_APPROVED => Self::Approved,
            STATUS_REJECTED => Self::Rejected,
            _ => env::panic_str("status must be held, approved, or rejected"),
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Hold {
    pub vendor: AccountId,
    pub amount: u128,
    pub memo: String,
    pub fund: String,
    pub status: HoldStatus,
}

/// Per-fund ledger. `received` is credited by the owner per settled gift;
/// `paid` grows with every successful payout from the fund.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub struct FundLedger {
    pub received: u128,
    pub paid: u128,
}

impl FundLedger {
    /// `received - paid`, never negative.
    pub fn available(&self) -> u128 {
        self.received.saturating_sub(self.paid)
    }
}

// ---------- views ----------

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ConfigView {
    pub owner: AccountId,
    pub agent: AccountId,
    pub usdc_token: AccountId,
    pub per_bill_limit: U128,
    pub monthly_cap: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AllowlistProposalView {
    pub vendor: AccountId,
    pub action: String,
    pub execute_after: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PayoutView {
    pub bill_id: String,
    pub vendor: AccountId,
    pub amount: U128,
    pub memo: String,
    pub fund: String,
    pub status: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct HoldView {
    pub bill_id: String,
    pub vendor: AccountId,
    pub amount: U128,
    pub memo: String,
    pub fund: String,
    pub status: String,
}

/// `available = received - paid`. `held` (outstanding holds) is shown but does
/// not reduce `available`; approving a hold re-checks `available`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct FundView {
    pub fund: String,
    pub received: U128,
    pub paid: U128,
    pub available: U128,
    pub held: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct MonthSpentView {
    pub year_month: String,
    pub spent: U128,
    pub cap: U128,
}

// ---------- contract ----------

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Treasury {
    owner: AccountId,
    agent: AccountId,
    usdc_token: AccountId,
    per_bill_limit: u128,
    monthly_cap: u128,
    /// Vendor -> active. A removed vendor stays known but inactive.
    vendors: IterableMap<AccountId, bool>,
    proposals: LookupMap<AccountId, AllowlistProposal>,
    payouts: LookupMap<String, Payout>,
    holds: IterableMap<String, Hold>,
    /// Calendar month (`YYYY-MM`, UTC) that `month_spent` belongs to.
    spent_month: String,
    month_spent: u128,
    /// Fund name -> ledger. Only the names in `FUNDS` are ever stored.
    fund_ledger: LookupMap<String, FundLedger>,
    /// Gift ids already credited, so a retried `credit_fund` cannot double-count.
    credited_gifts: LookupSet<String>,
}

#[near]
impl Treasury {
    #[init]
    pub fn new(
        owner: AccountId,
        agent: AccountId,
        usdc_token: AccountId,
        per_bill_limit: U128,
        monthly_cap: U128,
        initial_allowlist: Vec<AccountId>,
    ) -> Self {
        require!(owner != agent, "owner and agent must differ");
        require!(per_bill_limit.0 > 0, "per_bill_limit must be > 0");
        require!(monthly_cap.0 > 0, "monthly_cap must be > 0");
        let mut this = Self {
            owner,
            agent,
            usdc_token,
            per_bill_limit: per_bill_limit.0,
            monthly_cap: monthly_cap.0,
            vendors: IterableMap::new(StorageKey::Vendors),
            proposals: LookupMap::new(StorageKey::Proposals),
            payouts: LookupMap::new(StorageKey::Payouts),
            holds: IterableMap::new(StorageKey::Holds),
            spent_month: year_month_from_ns(env::block_timestamp()),
            month_spent: 0,
            fund_ledger: LookupMap::new(StorageKey::FundLedger),
            credited_gifts: LookupSet::new(StorageKey::CreditedGifts),
        };
        // Initial vendors are part of deploy-time configuration, not a later
        // "change": they are active immediately. Subsequent add/remove still
        // wait 24 hours via propose_allowlist_change / execute_allowlist_change.
        for vendor in initial_allowlist {
            this.vendors.insert(vendor.clone(), true);
            emit("allowlist_executed", json!({ "vendor": vendor, "action": "add" }));
        }
        this
    }

    // ---------- change methods ----------

    /// Agent only. Pays immediately, creates a hold, or panics. Returns `"held"`
    /// for a hold; for a payment returns the ft_transfer promise, resolved to
    /// `"paid"` (or `"transfer_failed"` if the token rejected the transfer, in
    /// which case the payout, cap usage and fund `paid` are rolled back).
    /// Both paths require `amount <= available` for `fund`.
    pub fn request_payout(
        &mut self,
        vendor: AccountId,
        amount: U128,
        bill_id: String,
        memo: String,
        fund: String,
    ) -> PromiseOrValue<String> {
        self.assert_agent();
        assert_fund(&fund);
        require!(!bill_id.is_empty(), "bill_id must be non-empty");
        require!(amount.0 > 0, "amount must be > 0");
        require!(
            !self.payouts.contains_key(&bill_id) && !self.holds.contains_key(&bill_id),
            "duplicate bill_id"
        );

        let decision = policy::decide_payout(
            self.vendors.get(&vendor).copied(),
            amount.0,
            self.per_bill_limit,
            self.current_month_spent(),
            self.monthly_cap,
        );

        if let PayoutDecision::Reject(reason) = decision {
            env::panic_str(reason.message());
        }
        // A hold that the fund already cannot cover is refused too.
        self.assert_fund_covers(&fund, amount.0);
        emit(
            "payout_requested",
            json!({ "bill_id": bill_id, "vendor": vendor, "amount": amount, "memo": memo, "fund": fund }),
        );

        match decision {
            PayoutDecision::Pay => {
                PromiseOrValue::Promise(self.pay(bill_id, vendor, amount.0, memo, fund, false))
            }
            PayoutDecision::Hold => {
                self.holds.insert(
                    bill_id.clone(),
                    Hold {
                        vendor: vendor.clone(),
                        amount: amount.0,
                        memo,
                        fund: fund.clone(),
                        status: HoldStatus::Held,
                    },
                );
                emit(
                    "payout_held",
                    json!({
                        "bill_id": bill_id,
                        "vendor": vendor,
                        "amount": amount,
                        "fund": fund,
                        "reason": REASON_OVER_PER_BILL_LIMIT,
                    }),
                );
                PromiseOrValue::Value(STATUS_HELD.to_string())
            }
            PayoutDecision::Reject(_) => unreachable!("rejected above"),
        }
    }

    /// Owner only. Re-checks the monthly cap, that the vendor is still active
    /// on the allowlist, and that the hold's fund still has `amount` available
    /// (another payout may have used it since), then transfers, marks the hold
    /// `approved` and records a `paid` payout.
    pub fn approve_hold(&mut self, bill_id: String) -> Promise {
        self.assert_owner();
        let mut hold = self.held(&bill_id);
        match self.vendors.get(&hold.vendor).copied() {
            Some(true) => {}
            Some(false) => env::panic_str("vendor is not active on the allowlist"),
            None => env::panic_str("vendor is not on the allowlist"),
        }
        require!(
            policy::fits_cap(self.current_month_spent(), hold.amount, self.monthly_cap),
            "monthly cap exceeded"
        );
        self.assert_fund_covers(&hold.fund, hold.amount);
        hold.status = HoldStatus::Approved;
        let (vendor, amount, memo, fund) =
            (hold.vendor.clone(), hold.amount, hold.memo.clone(), hold.fund.clone());
        self.holds.insert(bill_id.clone(), hold);
        emit("hold_approved", json!({ "bill_id": bill_id }));
        self.pay(bill_id, vendor, amount, memo, fund, true)
    }

    /// Owner only. Records `amount` received into `fund` for settled gift
    /// `gift_id`. Ledger only: no NEP-141 tokens move here. The caller must
    /// already have credited the treasury's token balance (testnet demo: the
    /// test-FT `mint`). Each `gift_id` can be credited once.
    pub fn credit_fund(&mut self, fund: String, amount: U128, gift_id: String) {
        self.assert_owner();
        assert_fund(&fund);
        require!(amount.0 > 0, "amount must be > 0");
        require!(!gift_id.is_empty(), "gift_id must be non-empty");
        require!(self.credited_gifts.insert(gift_id.clone()), "duplicate gift_id: gift already credited");
        let mut ledger = self.ledger(&fund);
        ledger.received = ledger
            .received
            .checked_add(amount.0)
            .unwrap_or_else(|| env::panic_str("fund received overflow"));
        let received = ledger.received;
        self.fund_ledger.insert(fund.clone(), ledger);
        emit(
            "fund_credited",
            json!({ "fund": fund, "amount": amount, "gift_id": gift_id, "received": U128(received) }),
        );
    }

    /// Owner only. Marks the hold `rejected`. No transfer, no cap usage, no
    /// fund ledger change.
    pub fn reject_hold(&mut self, bill_id: String) {
        self.assert_owner();
        let mut hold = self.held(&bill_id);
        hold.status = HoldStatus::Rejected;
        self.holds.insert(bill_id.clone(), hold);
        emit("hold_rejected", json!({ "bill_id": bill_id }));
    }

    /// Owner only. Stores (or replaces) the pending proposal for `vendor`,
    /// executable 24 hours from now.
    pub fn propose_allowlist_change(&mut self, vendor: AccountId, action: String) {
        self.assert_owner();
        let action = AllowlistAction::parse(&action);
        let execute_after = env::block_timestamp()
            .checked_add(ALLOWLIST_DELAY_NS)
            .unwrap_or_else(|| env::panic_str("timestamp overflow"));
        emit(
            "allowlist_proposed",
            json!({ "vendor": vendor, "action": action.as_str(), "execute_after": U64(execute_after) }),
        );
        self.proposals.insert(vendor, AllowlistProposal { action, execute_after });
    }

    /// Any account. Applies the pending proposal once its delay has passed.
    pub fn execute_allowlist_change(&mut self, vendor: AccountId) {
        let proposal = self
            .proposals
            .remove(&vendor)
            .unwrap_or_else(|| env::panic_str("no pending allowlist proposal for vendor"));
        require!(
            env::block_timestamp() >= proposal.execute_after,
            "allowlist change delay has not passed"
        );
        match proposal.action {
            AllowlistAction::Add => {
                self.vendors.insert(vendor.clone(), true);
            }
            AllowlistAction::Remove => {
                if self.vendors.contains_key(&vendor) {
                    self.vendors.insert(vendor.clone(), false);
                }
            }
        }
        emit("allowlist_executed", json!({ "vendor": vendor, "action": proposal.action.as_str() }));
    }

    /// Owner only. Both limits > 0. Immediate; does not touch `month_spent`.
    pub fn set_limits(&mut self, per_bill_limit: U128, monthly_cap: U128) {
        self.assert_owner();
        require!(per_bill_limit.0 > 0, "per_bill_limit must be > 0");
        require!(monthly_cap.0 > 0, "monthly_cap must be > 0");
        self.per_bill_limit = per_bill_limit.0;
        self.monthly_cap = monthly_cap.0;
        emit(
            "limits_updated",
            json!({ "per_bill_limit": per_bill_limit, "monthly_cap": monthly_cap }),
        );
    }

    /// Resolves the ft_transfer started by `request_payout` / `approve_hold`.
    /// On failure, undoes the payout record, cap usage and fund `paid` (and
    /// returns an approved hold to `held`).
    #[private]
    pub fn on_payout_transfer(
        &mut self,
        bill_id: String,
        year_month: String,
        amount: U128,
        from_hold: bool,
    ) -> String {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "on_payout_transfer is private"
        );
        let ok = !matches!(env::promise_result_checked(0, 256), Err(PromiseError::Failed));
        if ok {
            // Emit only after ft_transfer succeeds so a rolled-back payout
            // is never advertised as paid.
            if let Some(payout) = self.payouts.get(&bill_id) {
                emit(
                    "payout_executed",
                    json!({
                        "bill_id": bill_id,
                        "vendor": payout.vendor,
                        "amount": U128(payout.amount),
                        "fund": payout.fund,
                    }),
                );
            }
            return STATUS_PAID.to_string();
        }
        if let Some(payout) = self.payouts.remove(&bill_id) {
            let mut ledger = self.ledger(&payout.fund);
            ledger.paid = ledger.paid.saturating_sub(payout.amount);
            self.fund_ledger.insert(payout.fund, ledger);
        }
        if self.spent_month == year_month {
            self.month_spent = self.month_spent.saturating_sub(amount.0);
        }
        if from_hold {
            if let Some(mut hold) = self.holds.get(&bill_id).cloned() {
                hold.status = HoldStatus::Held;
                self.holds.insert(bill_id.clone(), hold);
            }
        }
        env::log_str(&format!("ft_transfer failed for bill_id {bill_id}; payout rolled back"));
        "transfer_failed".to_string()
    }

    // ---------- views ----------

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner: self.owner.clone(),
            agent: self.agent.clone(),
            usdc_token: self.usdc_token.clone(),
            per_bill_limit: U128(self.per_bill_limit),
            monthly_cap: U128(self.monthly_cap),
        }
    }

    pub fn get_allowlist(&self) -> Vec<AccountId> {
        self.vendors.iter().filter(|(_, active)| **active).map(|(v, _)| v.clone()).collect()
    }

    pub fn get_proposal(&self, vendor: AccountId) -> Option<AllowlistProposalView> {
        self.proposals.get(&vendor).map(|p| AllowlistProposalView {
            vendor,
            action: p.action.as_str().to_string(),
            execute_after: U64(p.execute_after),
        })
    }

    pub fn get_payout(&self, bill_id: String) -> Option<PayoutView> {
        self.payouts.get(&bill_id).map(|p| PayoutView {
            bill_id,
            vendor: p.vendor.clone(),
            amount: U128(p.amount),
            memo: p.memo.clone(),
            fund: p.fund.clone(),
            status: STATUS_PAID.to_string(),
        })
    }

    pub fn get_hold(&self, bill_id: String) -> Option<HoldView> {
        self.holds.get(&bill_id).map(|h| hold_view(&bill_id, h))
    }

    pub fn list_holds(&self, status: Option<String>) -> Vec<HoldView> {
        let filter = status.as_deref().map(HoldStatus::parse);
        self.holds
            .iter()
            .filter(|(_, h)| filter.as_ref().map_or(true, |s| &h.status == s))
            .map(|(id, h)| hold_view(id, h))
            .collect()
    }

    /// Ledger for one fund. Panics on an unknown fund name.
    pub fn get_fund(&self, fund: String) -> FundView {
        assert_fund(&fund);
        let held = self.held_by_fund();
        self.fund_view(&fund, &held)
    }

    /// Ledgers for all funds, in `FUNDS` order.
    pub fn get_fund_ledger(&self) -> Vec<FundView> {
        let held = self.held_by_fund();
        FUNDS.iter().map(|f| self.fund_view(f, &held)).collect()
    }

    pub fn get_month_spent(&self) -> MonthSpentView {
        MonthSpentView {
            year_month: year_month_from_ns(env::block_timestamp()),
            spent: U128(self.current_month_spent()),
            cap: U128(self.monthly_cap),
        }
    }
}

impl Treasury {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "unauthorized: caller is not owner");
    }

    fn assert_agent(&self) {
        require!(env::predecessor_account_id() == self.agent, "unauthorized: caller is not agent");
    }

    /// Spent amount for the current UTC month (0 if the month has rolled over).
    fn current_month_spent(&self) -> u128 {
        if self.spent_month == year_month_from_ns(env::block_timestamp()) {
            self.month_spent
        } else {
            0
        }
    }

    fn ledger(&self, fund: &str) -> FundLedger {
        self.fund_ledger.get(fund).cloned().unwrap_or_default()
    }

    fn assert_fund_covers(&self, fund: &str, amount: u128) {
        let available = self.ledger(fund).available();
        if amount > available {
            env::panic_str(&format!(
                "{ERR_INSUFFICIENT_FUND}: {fund} has {available} available, bill needs {amount}"
            ));
        }
    }

    /// Outstanding (`held`) hold amounts per fund, in `FUNDS` order.
    fn held_by_fund(&self) -> [u128; 3] {
        let mut held = [0u128; 3];
        for (_, h) in self.holds.iter().filter(|(_, h)| h.status == HoldStatus::Held) {
            if let Some(i) = FUNDS.iter().position(|f| *f == h.fund) {
                held[i] = held[i].saturating_add(h.amount);
            }
        }
        held
    }

    fn fund_view(&self, fund: &str, held: &[u128; 3]) -> FundView {
        let ledger = self.ledger(fund);
        let i = FUNDS.iter().position(|f| *f == fund).unwrap_or_else(|| env::panic_str(ERR_INVALID_FUND));
        FundView {
            fund: fund.to_string(),
            received: U128(ledger.received),
            paid: U128(ledger.paid),
            available: U128(ledger.available()),
            held: U128(held[i]),
        }
    }

    fn held(&self, bill_id: &str) -> Hold {
        let hold = self
            .holds
            .get(bill_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("hold not found"));
        require!(hold.status == HoldStatus::Held, "hold is not held");
        hold
    }

    /// Records a `paid` payout, consumes cap and fund balance, and starts the
    /// USDC transfer. Callers have already checked policy and fund balance.
    fn pay(
        &mut self,
        bill_id: String,
        vendor: AccountId,
        amount: u128,
        memo: String,
        fund: String,
        from_hold: bool,
    ) -> Promise {
        let year_month = year_month_from_ns(env::block_timestamp());
        let spent = self.current_month_spent();
        self.spent_month = year_month.clone();
        self.month_spent = spent
            .checked_add(amount)
            .unwrap_or_else(|| env::panic_str("monthly cap exceeded"));
        let mut ledger = self.ledger(&fund);
        ledger.paid = ledger.paid.checked_add(amount).unwrap_or_else(|| env::panic_str("fund paid overflow"));
        self.fund_ledger.insert(fund.clone(), ledger);
        self.payouts.insert(bill_id.clone(), Payout { vendor: vendor.clone(), amount, memo, fund });
        ext_ft::ext(self.usdc_token.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(vendor, U128(amount), Some(format!("openlid:{bill_id}")))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RESOLVE_TRANSFER)
                    .on_payout_transfer(bill_id, year_month, U128(amount), from_hold),
            )
    }
}

fn hold_view(bill_id: &str, h: &Hold) -> HoldView {
    HoldView {
        bill_id: bill_id.to_string(),
        vendor: h.vendor.clone(),
        amount: U128(h.amount),
        memo: h.memo.clone(),
        fund: h.fund.clone(),
        status: h.status.as_str().to_string(),
    }
}

fn assert_fund(fund: &str) {
    require!(FUNDS.contains(&fund), ERR_INVALID_FUND);
}

/// Emits a NEP-297 event under the `openlid` standard.
fn emit(event: &str, data: serde_json::Value) {
    let payload = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{payload}"));
}

#[cfg(test)]
mod tests;
