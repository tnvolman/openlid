//! Pure policy decisions, kept free of contract state so they can be unit
//! tested directly. The contract calls these and then performs the transfer.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RejectReason {
    UnknownVendor,
    InactiveVendor,
    CapExceeded,
}

impl RejectReason {
    pub fn message(&self) -> &'static str {
        match self {
            Self::UnknownVendor => "vendor is not on the allowlist",
            Self::InactiveVendor => "vendor is not active on the allowlist",
            Self::CapExceeded => "monthly cap exceeded",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayoutDecision {
    /// Transfer now, status `paid`.
    Pay,
    /// No transfer, create a hold with reason `over_per_bill_limit`.
    Hold,
    Reject(RejectReason),
}

/// `vendor_active` is `None` for a vendor never added, `Some(false)` for a
/// removed vendor.
pub fn decide_payout(
    vendor_active: Option<bool>,
    amount: u128,
    per_bill_limit: u128,
    month_spent: u128,
    monthly_cap: u128,
) -> PayoutDecision {
    match vendor_active {
        None => return PayoutDecision::Reject(RejectReason::UnknownVendor),
        Some(false) => return PayoutDecision::Reject(RejectReason::InactiveVendor),
        Some(true) => {}
    }
    if !fits_cap(month_spent, amount, monthly_cap) {
        return PayoutDecision::Reject(RejectReason::CapExceeded);
    }
    if amount <= per_bill_limit {
        PayoutDecision::Pay
    } else {
        PayoutDecision::Hold
    }
}

/// `month_spent + amount <= monthly_cap`, overflow-safe.
pub fn fits_cap(month_spent: u128, amount: u128, monthly_cap: u128) -> bool {
    month_spent.checked_add(amount).is_some_and(|total| total <= monthly_cap)
}

/// Calendar month in UTC as `YYYY-MM` for a block timestamp in nanoseconds.
pub fn year_month_from_ns(timestamp_ns: u64) -> String {
    let days = (timestamp_ns / 86_400_000_000_000) as i64;
    let (year, month) = civil_year_month(days);
    format!("{year:04}-{month:02}")
}

/// Days since 1970-01-01 to (year, month). Howard Hinnant's `civil_from_days`.
fn civil_year_month(days: i64) -> (i64, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    (year, month)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIMIT: u128 = 1_000;
    const CAP: u128 = 5_000;

    #[test]
    fn at_limit_pays_above_limit_holds() {
        assert_eq!(decide_payout(Some(true), LIMIT, LIMIT, 0, CAP), PayoutDecision::Pay);
        assert_eq!(decide_payout(Some(true), LIMIT + 1, LIMIT, 0, CAP), PayoutDecision::Hold);
    }

    #[test]
    fn cap_is_checked_for_pay_and_hold() {
        assert_eq!(decide_payout(Some(true), 1, LIMIT, CAP, CAP), PayoutDecision::Reject(RejectReason::CapExceeded));
        assert_eq!(decide_payout(Some(true), LIMIT, LIMIT, CAP - LIMIT, CAP), PayoutDecision::Pay);
        assert_eq!(
            decide_payout(Some(true), CAP + 1, LIMIT, 0, CAP),
            PayoutDecision::Reject(RejectReason::CapExceeded)
        );
        assert!(!fits_cap(u128::MAX, 1, u128::MAX));
    }

    #[test]
    fn unknown_and_inactive_vendors_rejected() {
        assert_eq!(decide_payout(None, 1, LIMIT, 0, CAP), PayoutDecision::Reject(RejectReason::UnknownVendor));
        assert_eq!(
            decide_payout(Some(false), 1, LIMIT, 0, CAP),
            PayoutDecision::Reject(RejectReason::InactiveVendor)
        );
    }

    #[test]
    fn year_month_utc() {
        assert_eq!(year_month_from_ns(0), "1970-01");
        // 2026-11-30T23:59:59Z and 2026-12-01T00:00:00Z
        assert_eq!(year_month_from_ns(1_796_083_199 * 1_000_000_000), "2026-11");
        assert_eq!(year_month_from_ns(1_796_083_200 * 1_000_000_000), "2026-12");
        // 2028-02-29T12:00:00Z (leap day) and 2028-03-01T00:00:00Z
        assert_eq!(year_month_from_ns(1_835_438_400 * 1_000_000_000), "2028-02");
        assert_eq!(year_month_from_ns(1_835_481_600 * 1_000_000_000), "2028-03");
    }
}
