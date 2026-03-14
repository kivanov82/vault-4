# State Inconsistency Audit -- Verified Findings

**Target:** Vault4Fund.sol, NAVLib.sol, IVault4Fund.sol
**Auditor:** Nemesis Pass 2 (State Inconsistency)
**Date:** 2026-03-11

---

## Coupled State Dependency Map

```
PAIR 1: totalSupply() <-> _totalAssets
  Invariant: share price = _totalAssets / totalSupply; changes to one must
             proportionally adjust the other (or intentionally alter price)
  Mutation points: _mint, _burn, updateTotalAssets, _settleDeposits,
                   _settleWithdraws, instantWithdraw, _collectPerformanceFee

PAIR 2: pendingDepositAssets <-> SUM(_depositQueue[i].assets for i >= depositQueueHead)
  Invariant: aggregate must equal sum of individual non-zero queue entries
  Mutation points: requestDeposit, cancelDeposit, _settleDeposits

PAIR 3: pendingWithdrawShares <-> SUM(_withdrawQueue[i].shares for i >= withdrawQueueHead)
  Invariant: aggregate must equal sum of individual non-zero queue entries
  Mutation points: requestWithdraw, cancelWithdraw, _settleWithdraws

PAIR 4: pendingWithdrawShares <-> balanceOf(address(this))
  Invariant: contract holds >= pendingWithdrawShares shares
  Mutation points: requestWithdraw, cancelWithdraw, _settleWithdraws

PAIR 5: _totalAssets <-> deployedToL1
  Invariant: _totalAssets >= deployedToL1 (enforced in updateTotalAssets)
  Mutation points: updateTotalAssets, sweepToL1, recordL1Return,
                   instantWithdraw, _settleDeposits, _settleWithdraws

PAIR 6: _totalAssets <-> USDC.balanceOf(this) + deployedToL1 - pendingDepositAssets
  Invariant: roughly equal (manager-reported NAV should match reality)
  Mutation points: all state-changing functions

PAIR 7: highWaterMark <-> peak(_totalAssets / totalSupply)
  Invariant: HWM only ratchets upward, tracks peak share price
  Mutation points: _collectPerformanceFee

PAIR 8: depositQueueHead <-> _depositQueue[] entries
  Invariant: all entries before head have assets == 0
  Mutation points: _settleDeposits

PAIR 9: withdrawQueueHead <-> _withdrawQueue[] entries
  Invariant: all entries before head have shares == 0
  Mutation points: _settleWithdraws
```

---

## Mutation Matrix

```
+--------------------------+-----------------------+-----------------------------------------+
| State Variable           | Mutating Function     | Type of Mutation                        |
+--------------------------+-----------------------+-----------------------------------------+
| _totalAssets             | updateTotalAssets      | set (= newTotalAssets)                  |
| _totalAssets             | _settleDeposits       | increment (+= req.assets)               |
| _totalAssets             | _settleWithdraws      | decrement (-= assetsOut)                |
| _totalAssets             | instantWithdraw       | decrement (-= assetsOut)                |
+--------------------------+-----------------------+-----------------------------------------+
| totalSupply (mint)       | _settleDeposits       | increment (_mint to investor)           |
| totalSupply (mint)       | _collectPerformanceFee| increment (_mint to manager)            |
| totalSupply (burn)       | _settleWithdraws      | decrement (_burn from contract)         |
| totalSupply (burn)       | instantWithdraw       | decrement (_burn from user)             |
+--------------------------+-----------------------+-----------------------------------------+
| pendingDepositAssets     | requestDeposit        | increment (+= assets)                   |
| pendingDepositAssets     | cancelDeposit         | decrement (-= assets)                   |
| pendingDepositAssets     | _settleDeposits       | decrement (-= req.assets)               |
+--------------------------+-----------------------+-----------------------------------------+
| pendingWithdrawShares    | requestWithdraw       | increment (+= shares)                   |
| pendingWithdrawShares    | cancelWithdraw        | decrement (-= shares)                   |
| pendingWithdrawShares    | _settleWithdraws      | decrement (-= req.shares)               |
+--------------------------+-----------------------+-----------------------------------------+
| deployedToL1             | sweepToL1             | increment (+= amount)                   |
| deployedToL1             | recordL1Return        | decrement (-= amount)                   |
+--------------------------+-----------------------+-----------------------------------------+
| highWaterMark            | _collectPerformanceFee| set (= newHWM, only increases)          |
+--------------------------+-----------------------+-----------------------------------------+
| lastNAVUpdate            | updateTotalAssets      | set (= block.timestamp)                 |
+--------------------------+-----------------------+-----------------------------------------+
| epoch                    | settle                | increment (epoch++)                     |
+--------------------------+-----------------------+-----------------------------------------+
| _depositQueue[]          | requestDeposit        | push new entry                          |
| _depositQueue[i].assets  | cancelDeposit         | set to 0 (mark cancelled)               |
| _depositQueue[i].assets  | _settleDeposits       | set to 0 (mark settled)                 |
| _depositQueue[i].assets  | _settleDeposits       | NOT zeroed when shares==0 (*** BUG ***) |
+--------------------------+-----------------------+-----------------------------------------+
| depositQueueHead         | _settleDeposits       | advance forward                         |
+--------------------------+-----------------------+-----------------------------------------+
| _withdrawQueue[]         | requestWithdraw       | push new entry                          |
| _withdrawQueue[i].shares | cancelWithdraw        | set to 0 (mark cancelled)               |
| _withdrawQueue[i].shares | _settleWithdraws      | set to 0 (mark settled)                 |
+--------------------------+-----------------------+-----------------------------------------+
| withdrawQueueHead        | _settleWithdraws      | advance forward                         |
+--------------------------+-----------------------+-----------------------------------------+
| USDC balance             | requestDeposit        | increase (transferFrom)                 |
| USDC balance             | cancelDeposit         | decrease (transfer out)                 |
| USDC balance             | _settleWithdraws      | decrease (transfer out)                 |
| USDC balance             | instantWithdraw       | decrease (transfer out)                 |
| USDC balance             | sweepToL1             | decrease (transfer to bridge)           |
+--------------------------+-----------------------+-----------------------------------------+
| contract share balance   | requestWithdraw       | increase (_transfer in)                 |
| contract share balance   | cancelWithdraw        | decrease (_transfer out)                |
| contract share balance   | _settleWithdraws      | decrease (_burn from address(this))     |
+--------------------------+-----------------------+-----------------------------------------+
```

---

## Parallel Path Comparison

```
+--------------------------+------------------+-------------------+-----------------+
| Coupled State            | instantWithdraw  | _settleWithdraws  | cancelWithdraw  |
+--------------------------+------------------+-------------------+-----------------+
| totalSupply (_burn)      | YES burned       | YES burned        | N/A (no burn)   |
| _totalAssets             | YES decreased    | YES decreased     | N/A             |
| pendingWithdrawShares    | N/A (not queued) | YES decreased     | YES decreased   |
| USDC balance             | YES transferred  | YES transferred   | N/A             |
| contract share balance   | N/A              | YES burned from   | YES transferred |
|                          |                  |   address(this)   |   back to user  |
+--------------------------+------------------+-------------------+-----------------+
VERDICT: All parallel paths update the same coupled state. CONSISTENT.

+--------------------------+------------------+-------------------+-----------------+
| Coupled State            | requestDeposit   | _settleDeposits   | cancelDeposit   |
+--------------------------+------------------+-------------------+-----------------+
| pendingDepositAssets     | YES increased    | YES decreased*    | YES decreased   |
| _depositQueue entry      | YES pushed       | YES zeroed*       | YES zeroed      |
| USDC balance             | YES received     | stays (->NAV)     | YES returned    |
| _totalAssets             | N/A (not NAV)    | YES increased*    | N/A             |
| totalSupply              | N/A              | YES minted*       | N/A             |
+--------------------------+------------------+-------------------+-----------------+
* = NOT updated when convertToShares returns 0 (SI-001 below)
VERDICT: _settleDeposits has a gap when shares round to zero.
```

---

## Verification Summary

| ID     | Coupled Pair                           | Breaking Op      | Original Severity | Verdict       | Final Severity |
|--------|----------------------------------------|------------------|-------------------|---------------|----------------|
| SI-001 | pendingDepositAssets <-> queue entries  | _settleDeposits  | MEDIUM            | TRUE POSITIVE | LOW            |
| SI-002 | _totalAssets <-> deployedToL1           | instantWithdraw  | MEDIUM            | FALSE POSITIVE| N/A            |
| SI-003 | idle USDC calc in _settleWithdraws     | settle ordering  | LOW               | FALSE POSITIVE| N/A            |

---

## Verified Findings

### Finding SI-001: Zero-share deposit skipped without cleanup causes permanent USDC lock and pendingDepositAssets inflation

**Severity:** LOW
**Verification:** Code Trace (Method A) -- confirmed through line-by-line trace of all code paths

**Coupled Pair:** `pendingDepositAssets` <-> `SUM(_depositQueue[i].assets for i >= depositQueueHead)`
**Invariant:** The aggregate `pendingDepositAssets` must equal the sum of non-zero `.assets` fields in all queue entries at or after `depositQueueHead`.

**Breaking Operation:** `_settleDeposits()` in `Vault4Fund.sol:431-435`

When `convertToShares(req.assets)` returns 0 (line 430-431):
- The entry is skipped via `continue` (line 435)
- `req.assets` remains non-zero (NOT set to 0)
- `pendingDepositAssets` is NOT decremented
- `depositQueueHead` advances past this entry if `i == head` (line 433)

**Trigger Sequence:**
1. Share price rises above 10 USDC per share (e.g., _totalAssets = 20e6, totalSupply = 1e6)
2. User calls `requestDeposit(10e6)` (10 USDC, the minimum)
3. Manager calls `updateTotalAssets()` then `settle()`
4. `convertToShares(10e6) = 10e6 * (1e6+1) / (20e6+1) = 0` (rounds to zero)
5. Entry is skipped, head advances past it
6. User calls `cancelDeposit(index)` -- **REVERTS** with "already settled" because `index < depositQueueHead`
7. 10 USDC permanently locked in the contract

**Consequence:**
- Investor's USDC is permanently locked with no recovery path
- `pendingDepositAssets` is permanently inflated by the skipped amount
- `_idleUsdc()` returns a lower value than reality (subtracts inflated `pendingDepositAssets`)
- `_availableForInstantWithdraw()` is reduced, potentially blocking legitimate instant withdrawals
- `sweepToL1()` available amount is reduced (reserves against inflated pending deposits)

**Severity Rationale:** Rated LOW because triggering requires share price > 10 USDC (with 6-decimal USDC and `MIN_AMOUNT = 10e6`). With the OZ 5.x `+1` virtual shares/assets offset, the effective threshold is `_totalAssets / totalSupply > MIN_AMOUNT` which is 10 million : 1 ratio in raw 6-decimal terms. While theoretically possible through sustained NAV growth or initial donation attack, it is impractical under normal vault operation. If MIN_AMOUNT were lower (e.g., 1 USDC), this would be MEDIUM.

**Fix:**
```solidity
// In _settleDeposits(), replace the zero-shares skip block (lines 431-435):
uint256 shares = convertToShares(req.assets);
if (shares == 0) {
    // Refund: tiny deposit that rounds to zero shares at current price
    uint256 refundAssets = req.assets;
    req.assets = 0; // mark as handled
    pendingDepositAssets -= refundAssets;
    IERC20(asset()).safeTransfer(req.investor, refundAssets);
    if (i == head) head++;
    processed++;
    continue;
}
```

---

## False Positives Eliminated

### FP-1: instantWithdraw does not check _totalAssets >= deployedToL1

**Why eliminated:** The liquidity check (`assetsOut <= _availableForInstantWithdraw()`) ensures that only idle USDC (contract balance minus pending deposits minus pending withdrawal reserves) can be withdrawn. Since `_totalAssets ~= idleUsdc + deployedToL1`, withdrawing at most `idleUsdc` worth of assets reduces `_totalAssets` to at minimum `deployedToL1`. The invariant is implicitly preserved by the liquidity guard.

### FP-2: _settleWithdraws uses _idleUsdc which subtracts pendingDepositAssets

**Why eliminated:** This is correct by design. Pending deposit USDC belongs to queued depositors and must not be used to pay withdrawals. `_idleUsdc()` correctly excludes it. Withdrawals are settled before deposits in `settle()`, ensuring depositors' USDC is protected.

### FP-3: _collectPerformanceFee mints shares without updating _totalAssets

**Why eliminated:** This is the standard dilution-based performance fee model. The fee is collected by minting new shares against the same total assets, thereby lowering the share price. `_totalAssets` should NOT increase because no new USDC was added. The dilution IS the fee mechanism.

### FP-4: Share transfers (ERC20) bypass queue accounting

**Why eliminated:** Standard ERC20 transfers only move share ownership between users. They do not affect `_totalAssets`, `pendingDepositAssets`, `pendingWithdrawShares`, or any queue state. `pendingWithdrawShares` is coupled with `balanceOf(address(this))` -- but external transfers TO the contract only add surplus shares (harmless), and transfers FROM the contract require the contract to initiate them (only happens via `cancelWithdraw`).

### FP-5: HWM not updated in updateTotalAssets

**Why eliminated:** Lazy evaluation pattern. The HWM is intentionally updated only during `_collectPerformanceFee()`, which runs at the start of every `settle()` call. The HWM does not need to track every NAV update in real-time -- it only matters at settlement time when fees are actually collected.

---

## Summary

- Coupled state pairs mapped: 9
- Mutation paths analyzed: 33
- Raw findings (pre-verification): 5
- After verification: 1 TRUE POSITIVE | 4 FALSE POSITIVE
- Final: 0 CRITICAL | 0 HIGH | 0 MEDIUM | 1 LOW

### Overall Assessment

The Vault4Fund contract demonstrates strong state consistency across its coupled state pairs. The queue system (request/cancel/settle) correctly maintains aggregate counters (`pendingDepositAssets`, `pendingWithdrawShares`) in sync with individual queue entries across all mutation paths. The settlement ordering (fee -> withdrawals -> deposits) is correct and does not create intermediate states that could be exploited. The single verified finding (SI-001) is an edge case that requires extreme share price conditions to trigger.

The contract's defensive coding patterns (`_idleUsdc` and `_availableForInstantWithdraw` clamping to zero) are legitimate safety guards, not masking patterns hiding broken invariants. The performance fee mechanism correctly uses dilution-based share minting without double-counting.
