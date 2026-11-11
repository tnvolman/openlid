# OpenLid test FT (`tUSDC`)

Minimal NEP-141 token used **only on NEAR testnet and in unit tests**. It stands
in for USDC so the testnet demo can credit the church treasury contract with $0
spend. It is not USDC, has no value, and must never be deployed to mainnet.

- Symbol `tUSDC`, 6 decimals (same atomic units as USDC).
- `new(owner)` — zero initial supply.
- `mint(account, amount)` — owner only, `amount > 0`. Registers `account` if
  needed (storage paid by this contract) and emits a NEP-297 `ft_mint` event.
- Standard NEP-141 (`ft_transfer` needs exactly 1 yoctoNEAR, `ft_transfer_call`,
  `ft_balance_of`, `ft_total_supply`), NEP-145 storage (`storage_deposit`, …),
  and NEP-148 `ft_metadata`, via `near-contract-standards`.
  `storage_unregister` is disabled.

The treasury contract's `usdc_token` is set to this token's testnet account id
in the demo. Vendors receiving payouts must be registered first
(`storage_deposit` or an owner `mint`), or the treasury's `ft_transfer` fails
and the payout is rolled back.

## Test

```sh
cd contracts/test-ft
cargo test
```

## Build

```sh
cd contracts/test-ft
cargo build --target wasm32-unknown-unknown --release
# -> target/wasm32-unknown-unknown/release/openlid_test_ft.wasm
```

Deployment to testnet is done by the demo script in the UI tree, not here. No
keys live in this directory.
