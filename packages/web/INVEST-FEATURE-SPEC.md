# Vault-4 Investment Feature — Frontend Integration Spec

## Status: Partially Implemented — Bugs to Fix

The hooks, ABI, and components are built. This document lists the **remaining work** to make them production-ready against the deployed contract.

## Deployed Contract

- **Address**: `0x9920F224123748eC1a1ADbAd4b941C510EC59948` (HyperEVM mainnet)
- **Chain ID**: `999` (NOT 1337)
- **Share Token**: V4FUND — **6 decimals** (same as USDC, no `_decimalsOffset`)
- **Asset**: USDC `0xb88339CB7199b77E23DB6E890353E22632Ba630f` (6 decimals)
- **Share Price**: 18-decimal precision (1e18 = 1.00 USDC/share)
- **Env Var**: `NEXT_PUBLIC_VAULT4FUND_ADDRESS=0x9920F224123748eC1a1ADbAd4b941C510EC59948`

---

## CRITICAL BUGS TO FIX

### 1. Wrong Chain ID in `lib/wagmi.ts`

**File**: `lib/wagmi.ts`
**Bug**: `id: 1337` → must be `id: 999`
**Also**: RPC URL should use the official endpoint, native currency is HYPE not USDC.

```ts
export const hyperliquidChain = defineChain({
  id: 999,                          // ← was 1337, must be 999
  name: "Hyperliquid",
  nativeCurrency: {
    name: "HYPE",                   // ← was "USDC"
    symbol: "HYPE",                 // ← was "USDC"
    decimals: 18,                   // ← was 6
  },
  rpcUrls: {
    default: { http: ["https://rpc.hyperliquid.xyz/evm"] },
  },
  blockExplorers: {
    default: {
      name: "Hyperliquid Explorer",
      url: "https://app.hyperliquid.xyz/explorer",
    },
  },
})
```

### 2. Wrong Share Decimals in `hooks/useVault4Fund.ts`

**File**: `hooks/useVault4Fund.ts`
**Bug**: `to18Dec()` is used for share values, but V4FUND has **6 decimals** (not 18).
Share price IS 18 decimals. Everything else (totalSupply, balanceOf, pendingWithdraws) is 6 decimals.

**Fix `useFundState()`:**
```ts
totalSupply: toUsdc(results[2] as bigint | undefined),              // ← was to18Dec, use toUsdc (6 dec)
pendingWithdrawsShares: toUsdc(results[7] as bigint | undefined),   // ← was to18Dec, use toUsdc (6 dec)
// sharePrice stays to18Dec (it's 18-decimal precision) ✓
// highWaterMark stays to18Dec (it's 18-decimal precision) ✓
```

**Fix `useInvestorState()`:**
```ts
shares: toUsdc(sharesRaw as bigint | undefined),   // ← was to18Dec, use toUsdc (6 dec)
```

### 3. Wrong Share Decimals in `hooks/useVault4FundWrite.ts`

**File**: `hooks/useVault4FundWrite.ts`
**Bug**: `parseUnits(shareAmount.toString(), 18)` → must be `6` for shares.

**Fix `useRequestWithdraw()`:**
```ts
const shares = parseUnits(shareAmount.toString(), 6)   // ← was 18
```

**Fix `useInstantWithdraw()`:**
```ts
const shares = parseUnits(shareAmount.toString(), 6)   // ← was 18
```

---

## REMAINING FEATURES TO BUILD

### 4. User's Pending Requests in `queue-status.tsx`

Currently only shows global queue stats. Needs to scan the queue for the connected user's pending requests and show cancel buttons.

**Implementation approach:**
- Read `depositQueueHead()` and `depositQueueLength()` from `useFundState()`
- For indices from `head` to `length - 1`, call `getDepositRequest(index)` and `getWithdrawRequest(index)`
- Filter for `investor === connectedAddress` and `assets > 0` (not cancelled/settled)
- Show each with a `[CANCEL]` button calling `cancelDeposit(index)` / `cancelWithdraw(index)`
- Use `useReadContracts` with a dynamic list of calls for batch reading

**Important**: Only scan unsettled entries (`head` to `length - 1`). Don't scan the full array — it grows unboundedly.

```tsx
// Pseudocode for scanning user's pending deposits
const head = fund.depositQueueHead   // add this to useFundState return
const len = fund.depositQueueLen

// Build contract calls for indices [head, len)
const depositCalls = Array.from({ length: len - head }, (_, i) => ({
  address: VAULT_ADDRESS,
  abi: vault4FundAbi,
  functionName: "getDepositRequest",
  args: [BigInt(head + i)],
}))

// Filter results where investor === address && assets > 0
```

**Note**: `depositQueueHead` is already in the ABI (`vault4fund-abi.ts` line 18) but not read by `useFundState()`. Add it to the `useReadContracts` calls.

### 5. Transaction Hash Links

After a successful deposit/withdraw/cancel, show the transaction hash as a clickable link to the explorer. The write hooks already return `hash` — just display it:

```tsx
{activeSuccess && hash && (
  <a href={`https://app.hyperliquid.xyz/explorer/tx/${hash}`}
     target="_blank" rel="noopener noreferrer"
     className="text-[color:var(--terminal-cyan)] hover:underline">
    TX: {hash.slice(0, 10)}...
  </a>
)}
```

### 6. Bridge Prompt Enhancement

When user has insufficient USDC on HyperEVM, show both bridge options:
- **Jumper Finance**: `https://jumper.exchange/` (cross-chain bridge)
- **Hyperliquid Native Bridge**: `https://app.hyperliquid.xyz/bridge` (from Arbitrum)

The `BridgeLink` component in `invest-panel.tsx` already links to Jumper. Consider adding both.

---

## FILE-BY-FILE CHANGE SUMMARY

| File | Changes Needed |
|------|---------------|
| `lib/wagmi.ts` | Chain ID 1337→999, native currency HYPE/18dec, RPC URL |
| `hooks/useVault4Fund.ts` | Share decimals 18→6 for `totalSupply`, `pendingWithdrawsShares`, `shares`. Add `depositQueueHead` to reads. |
| `hooks/useVault4FundWrite.ts` | Share decimals 18→6 in `useRequestWithdraw` and `useInstantWithdraw` |
| `components/queue-status.tsx` | Add user's pending requests scanning + cancel buttons |
| `components/invest-panel.tsx` | Add tx hash links after success |
| `lib/vault4fund-abi.ts` | Already correct, no changes |
| `components/fund-metrics.tsx` | Already correct, no changes |
| `components/terminal-portfolio.tsx` | Already correct, no changes |

---

## CONTRACT ABI REFERENCE

### Read Functions (views)
```solidity
function sharePrice() → uint256          // 18-decimal precision (1e18 = 1 USDC/share)
function totalAssets() → uint256         // Total NAV in USDC (6 dec)
function totalSupply() → uint256         // Total shares outstanding (6 dec)
function balanceOf(address) → uint256    // User's share balance (6 dec)
function convertToAssets(uint256 shares) → uint256  // Shares → USDC value
function convertToShares(uint256 assets) → uint256  // USDC → shares
function availableForInstantWithdraw() → uint256    // Idle USDC available (6 dec)
function pendingDeposits() → uint256     // Total queued deposit USDC (6 dec)
function pendingWithdraws() → uint256    // Total queued withdrawal shares (6 dec)
function depositQueueLength() → uint256
function withdrawQueueLength() → uint256
function depositQueueHead() → uint256
function getDepositRequest(uint256 index) → (address investor, uint256 assets, uint64 requestedAt)
function getWithdrawRequest(uint256 index) → (address investor, uint256 shares, uint64 requestedAt)
function epoch() → uint256              // Settlement cycle counter
function paused() → bool
function manager() → address
function deployedToL1() → uint256       // USDC deployed to Hyperliquid L1 (6 dec)
function highWaterMark() → uint256      // HWM for performance fee (18 dec)
```

### Write Functions (transactions)
```solidity
function requestDeposit(uint256 assets)  // Queue deposit — assets in 6 dec (requires USDC approval first)
function requestWithdraw(uint256 shares) // Queue withdrawal — shares in 6 dec
function cancelDeposit(uint256 index)    // Cancel pending deposit
function cancelWithdraw(uint256 index)   // Cancel pending withdrawal
function instantWithdraw(uint256 shares) // Instant if liquidity available — shares in 6 dec
```

### Events
```solidity
event DepositQueued(address indexed investor, uint256 assets, uint256 index)
event WithdrawQueued(address indexed investor, uint256 shares, uint256 index)
event DepositCancelled(address indexed investor, uint256 assets, uint256 index)
event WithdrawCancelled(address indexed investor, uint256 shares, uint256 index)
event InstantWithdraw(address indexed investor, uint256 shares, uint256 assets)
event Settled(uint256 indexed epoch, uint256 totalAssets, uint256 depositsProcessed, uint256 withdrawsProcessed)
```

---

## DESIGN SYSTEM

Follow the existing cyberpunk terminal aesthetic from `app/globals.css`:

- **Green** (`--terminal-green`): positive values, share price gains, TVL, default text
- **Cyan** (`--terminal-cyan`): fund metrics, share balance, epoch, links
- **Amber** (`--terminal-amber`): pending/queued items, settlement countdown, warnings
- **Red** (`--terminal-red` / `destructive`): negative values, errors, insufficient balance

Existing patterns to reuse:
- `terminal-border` / `terminal-border-inset` / `terminal-border-hero` for panel borders
- `terminal-border-amber` / `terminal-border-cyan` for accent panels
- `BlinkingLabel` with varied prefixes (`>`, `$`, `!`, `::`) and colors
- `terminal-button` / `terminal-button-locked` for active/disabled states
- `TerminalSkeletonLine` for loading states
- Count-up animations (see `performance-metrics.tsx`)

---

## EDGE CASES

1. **Wallet not connected**: Show "CONNECT WALLET" button, disable deposit/withdraw ✓ (already handled)
2. **Contract not configured** (`NEXT_PUBLIC_VAULT4FUND_ADDRESS` missing): Hide invest panels ✓ (already handled)
3. **Wrong chain**: Show chain switch button ✓ (already handled in `terminal-header.tsx`)
4. **Contract paused**: Show amber warning, disable buttons ✓ (already handled)
5. **Insufficient USDC**: Show bridge prompt, disable deposit ✓ (already handled)
6. **USDC not approved**: Show "APPROVE USDC" button first ✓ (already handled)
7. **Below minimum (10 USDC)**: Show validation message ✓ (already handled)
8. **Zero shares**: Withdrawal input accepts 0 but validation catches it ✓ (already handled)
9. **Instant withdraw unavailable**: Show queued-only option with explanation ✓ (already handled)

---

## SETTLEMENT SCHEDULE

- **Daily at 3PM CET** (14:00 UTC in winter, 13:00 UTC in summer)
- Backend triggers `updateTotalAssets()` → `settle()` on the contract
- Countdown timer in `invest-panel.tsx` ✓ (already implemented)
- After settlement: wagmi auto-refetches every 15s ✓ (already configured)
