# State Inconsistency Audit -- Raw Findings (Pre-Verification)

**Target:** Vault4Fund.sol, NAVLib.sol, IVault4Fund.sol

## Raw Candidate Findings

### RC-1: Zero-share deposit skipped without cleanup
- **Coupled Pair:** pendingDepositAssets <-> queue entries
- **Location:** Vault4Fund.sol:431-435
- **Status:** -> VERIFIED as SI-001 (LOW)

### RC-2: instantWithdraw may break _totalAssets >= deployedToL1
- **Coupled Pair:** _totalAssets <-> deployedToL1
- **Location:** Vault4Fund.sol:208-223
- **Status:** -> ELIMINATED (liquidity check implicitly preserves invariant)

### RC-3: _settleWithdraws idle calculation includes pending deposits
- **Coupled Pair:** idle USDC <-> pendingDepositAssets
- **Location:** Vault4Fund.sol:477 -> _idleUsdc()
- **Status:** -> ELIMINATED (correct by design -- pending deposit USDC is reserved)

### RC-4: _collectPerformanceFee mints without _totalAssets update
- **Coupled Pair:** totalSupply <-> _totalAssets
- **Location:** Vault4Fund.sol:382-408
- **Status:** -> ELIMINATED (dilution-based fee model, _totalAssets intentionally unchanged)

### RC-5: HWM stale between updateTotalAssets and settle
- **Coupled Pair:** highWaterMark <-> share price
- **Location:** Vault4Fund.sol:234-239
- **Status:** -> ELIMINATED (lazy evaluation, HWM only needed at settlement)
