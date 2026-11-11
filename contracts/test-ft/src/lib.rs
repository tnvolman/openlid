//! OpenLid test FT: a minimal NEP-141 token (`tUSDC`, 6 decimals) for NEAR
//! testnet and unit tests only. It stands in for USDC so the testnet demo can
//! credit the church treasury contract without real funds. Not for mainnet.
//!
//! Standard NEP-141 / NEP-145 / NEP-148 behaviour comes from
//! `near-contract-standards`. The only addition is owner-only `mint`.

use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue,
};

pub const DECIMALS: u8 = 6;
pub const SYMBOL: &str = "tUSDC";
pub const NAME: &str = "OpenLid Test USDC (testnet only)";

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Accounts,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct TestFt {
    owner: AccountId,
    token: FungibleToken,
}

#[near]
impl TestFt {
    /// Creates the token with zero supply. Only `owner` can mint.
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self { owner, token: FungibleToken::new(StorageKey::Accounts) }
    }

    /// Owner only. Credits `amount` (atomic units, 6 decimals) to `account`,
    /// registering it first if needed (storage paid from this contract's own
    /// balance, which is fine for a testnet-only token).
    pub fn mint(&mut self, account: AccountId, amount: U128) {
        require!(
            env::predecessor_account_id() == self.owner,
            "unauthorized: caller is not owner"
        );
        require!(amount.0 > 0, "amount must be > 0");
        if !self.token.accounts.contains_key(&account) {
            self.token.internal_register_account(&account);
        }
        self.token.internal_deposit(&account, amount.0);
        FtMint { owner_id: &account, amount, memo: Some("openlid test mint") }.emit();
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }
}

#[near]
impl FungibleTokenCore for TestFt {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for TestFt {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used, _burned) =
            self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used.into()
    }
}

#[near]
impl StorageManagement for TestFt {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        // Unregistering burns any balance; not needed for the demo.
        let _ = force;
        env::panic_str("storage_unregister is disabled on the test FT")
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for TestFt {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: NAME.to_string(),
            symbol: SYMBOL.to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: DECIMALS,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    const ONE_TUSDC: u128 = 1_000_000;

    fn owner() -> AccountId {
        "owner.near".parse().unwrap()
    }
    fn treasury() -> AccountId {
        "treasury.near".parse().unwrap()
    }
    fn vendor() -> AccountId {
        "vendor.near".parse().unwrap()
    }
    fn token_id() -> AccountId {
        "usdc.near".parse().unwrap()
    }

    fn ctx(caller: AccountId, deposit: NearToken) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(token_id())
            .predecessor_account_id(caller.clone())
            .signer_account_id(caller)
            .attached_deposit(deposit)
            .build());
    }

    fn init() -> TestFt {
        ctx(owner(), NearToken::from_yoctonear(0));
        TestFt::new(owner())
    }

    #[test]
    fn metadata_is_tusdc_6_decimals() {
        let c = init();
        let m = c.ft_metadata();
        assert_eq!(m.symbol, "tUSDC");
        assert_eq!(m.decimals, 6);
        assert_eq!(m.spec, FT_METADATA_SPEC);
        m.assert_valid();
        assert_eq!(c.ft_total_supply(), U128(0));
        assert_eq!(c.get_owner(), owner());
    }

    #[test]
    fn owner_mint_credits_and_registers_account() {
        let mut c = init();
        assert!(c.storage_balance_of(treasury()).is_none());
        c.mint(treasury(), U128(500 * ONE_TUSDC));
        assert_eq!(c.ft_balance_of(treasury()), U128(500 * ONE_TUSDC));
        assert_eq!(c.ft_total_supply(), U128(500 * ONE_TUSDC));
        assert!(c.storage_balance_of(treasury()).is_some());
        assert!(get_logs().iter().any(|l| l.starts_with("EVENT_JSON:")
            && l.contains("\"event\":\"ft_mint\"")
            && l.contains("\"owner_id\":\"treasury.near\"")));

        // Minting again to a registered account adds to the balance.
        c.mint(treasury(), U128(ONE_TUSDC));
        assert_eq!(c.ft_balance_of(treasury()), U128(501 * ONE_TUSDC));
        assert_eq!(c.ft_total_supply(), U128(501 * ONE_TUSDC));
    }

    #[test]
    #[should_panic(expected = "unauthorized: caller is not owner")]
    fn non_owner_cannot_mint() {
        let mut c = init();
        ctx(treasury(), NearToken::from_yoctonear(0));
        c.mint(treasury(), U128(ONE_TUSDC));
    }

    #[test]
    #[should_panic(expected = "amount must be > 0")]
    fn mint_zero_panics() {
        let mut c = init();
        c.mint(treasury(), U128(0));
    }

    /// Owner mints to itself, then transfers into a treasury-like account that
    /// registered via storage_deposit, as the demo settlement adapter does.
    #[test]
    fn transfer_into_treasury_account() {
        let mut c = init();
        c.mint(owner(), U128(1_000 * ONE_TUSDC));

        let min = c.storage_balance_bounds().min;
        ctx(owner(), min);
        c.storage_deposit(Some(treasury()), Some(true));

        ctx(owner(), NearToken::from_yoctonear(1));
        c.ft_transfer(treasury(), U128(250 * ONE_TUSDC), Some("gift settlement".into()));
        assert_eq!(c.ft_balance_of(treasury()), U128(250 * ONE_TUSDC));
        assert_eq!(c.ft_balance_of(owner()), U128(750 * ONE_TUSDC));
        assert_eq!(c.ft_total_supply(), U128(1_000 * ONE_TUSDC));
    }

    /// The treasury contract pays vendors with ft_transfer + 1 yoctoNEAR.
    #[test]
    fn treasury_account_can_pay_registered_vendor() {
        let mut c = init();
        c.mint(treasury(), U128(100 * ONE_TUSDC));
        c.mint(vendor(), U128(1)); // registers vendor

        ctx(treasury(), NearToken::from_yoctonear(1));
        c.ft_transfer(vendor(), U128(40 * ONE_TUSDC), Some("openlid:bill-1".into()));
        assert_eq!(c.ft_balance_of(treasury()), U128(60 * ONE_TUSDC));
        assert_eq!(c.ft_balance_of(vendor()), U128(40 * ONE_TUSDC + 1));
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn transfer_requires_one_yocto() {
        let mut c = init();
        c.mint(treasury(), U128(ONE_TUSDC));
        c.mint(vendor(), U128(1));
        ctx(treasury(), NearToken::from_yoctonear(0));
        c.ft_transfer(vendor(), U128(1), None);
    }

    #[test]
    #[should_panic(expected = "The account vendor.near is not registered")]
    fn transfer_to_unregistered_account_panics() {
        let mut c = init();
        c.mint(treasury(), U128(ONE_TUSDC));
        ctx(treasury(), NearToken::from_yoctonear(1));
        c.ft_transfer(vendor(), U128(1), None);
    }
}
