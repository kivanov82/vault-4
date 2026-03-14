# CLAUDE.md — Contracts Package

This is the **smart contracts** (`packages/contracts/`) within the vault-4 monorepo.

## Overview

ERC-4626 investment vault on HyperEVM (Hyperliquid's EVM chain). Accepts USDC deposits from external investors, issues proportional shares (V4FUND), and queues settlement daily at 3PM CET.

## Tech Stack

- **Framework**: Foundry (forge, cast, anvil)
- **Solidity**: 0.8.28
- **Dependencies**: OpenZeppelin Contracts 5.x (via forge install, in `lib/`)
- **EVM Target**: HyperEVM (chainId 1337, Cancun)

## Commands

```bash
forge build           # Compile contracts
forge test -vvv       # Run tests with verbose output
forge test --gas-report  # Gas report
forge fmt             # Format Solidity files
```

## Architecture

```
src/
  Vault4Fund.sol              # Main ERC-4626 vault contract
  interfaces/
    IVault4Fund.sol           # External interface (events, structs, function sigs)
  lib/
    NAVLib.sol                # Pure math for NAV and performance fee calculations
test/
  Vault4Fund.t.sol            # Foundry test suite (44 tests)
  mocks/
    ERC20Mock.sol             # ERC20 mock for testing
script/
  Deploy.s.sol                # Deployment script
```

## Key Addresses (HyperEVM Mainnet)

- Vault4Fund: `0xb6099d4545156f8ACA1A8Ea7CAA0762D81697809`
- USDC: `0xb88339CB7199b77E23DB6E890353E22632Ba630f`
- USDC System Address: `0x2000000000000000000000000000000000000000` (blacklisted — NOT used)
- CoreDepositWallet: `0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24` (EVM→L1 bridge for contracts)

## Contract Design

### NAV Model
- Manager-reported: `updateTotalAssets(uint256)` sets the NAV
- Share price = `totalAssets / totalSupply` (ERC-4626 standard)
- `totalAssets()` returns manager-reported value, NOT contract USDC balance

### Queue System
- Deposits and withdrawals are queued, settled daily by manager
- Head/tail pointer pattern (O(1) gas per settlement)
- Anti-frontrunning: only requests submitted BEFORE `lastNAVUpdate` are settled
- Instant withdrawals available if idle USDC covers the amount

### Performance Fee
- 10% on profit above high-water mark (per-share price)
- Fee minted as new shares to manager
- HWM only ratchets upward

### Bridge
- `sweepToL1(amount)`: transfers USDC to **manager wallet** (not system address — it's blacklisted). Backend then bridges manager wallet EVM→L1 via `usdClassTransfer(Spot→Perps)`
- `recordL1Return(amount)`: accounting update when USDC returns from L1 (via `spotSend` from L1 to contract)
- Sweep is guarded: must leave enough for pending withdrawals

## Conventions

- Solidity 0.8.28 with Cancun EVM
- OpenZeppelin via `lib/` (Foundry git submodules), remapped as `@openzeppelin/contracts/`
- USDC amounts in 6 decimals throughout
- Share prices in 18-decimal precision (NAVLib.PRECISION = 1e18)
