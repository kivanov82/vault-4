"use client"

import { useMemo } from "react"
import { useAccount, useReadContracts } from "wagmi"
import { BlinkingLabel } from "./blinking-label"
import { TerminalSkeletonLine } from "./terminal-skeleton"
import { useFundState } from "@/hooks/useVault4Fund"
import { useCancelDeposit, useCancelWithdraw } from "@/hooks/useVault4FundWrite"
import { vault4FundAbi } from "@/lib/vault4fund-abi"
import { formatUnits } from "viem"

const VAULT_ADDRESS = process.env.NEXT_PUBLIC_VAULT4FUND_ADDRESS as `0x${string}` | undefined

type PendingRequest = {
  type: "deposit" | "withdraw"
  index: number
  amount: number
  requestedAt: number
}

export function QueueStatus() {
  const fund = useFundState()
  const { address } = useAccount()

  if (!fund.configured) return null

  const hasQueue = fund.pendingDepositsUsdc > 0 || fund.pendingWithdrawsShares > 0

  // Hide entirely when there's nothing pending and no connected user to show requests for
  if (!hasQueue && !fund.isLoading && !address) return null

  return (
    <div className="terminal-border-amber p-3">
      <BlinkingLabel text="PENDING REQUESTS" prefix="!" color="amber" />

      {/* Global queue stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-3">
        <div className="terminal-border-inset p-2">
          <span className="text-[10px] text-[color:var(--terminal-amber-dim)] block">PENDING_DEPOSITS</span>
          {fund.isLoading ? (
            <TerminalSkeletonLine className="w-20 h-4 mt-1" />
          ) : (
            <span className="text-sm font-semibold text-[color:var(--terminal-amber)]">
              ${fund.pendingDepositsUsdc.toFixed(2)}
              <span className="text-[10px] text-[color:var(--terminal-amber-dim)] ml-1">
                ({fund.depositQueueLen - fund.depositQueueHead})
              </span>
            </span>
          )}
        </div>
        <div className="terminal-border-inset p-2">
          <span className="text-[10px] text-[color:var(--terminal-amber-dim)] block">PENDING_WITHDRAWALS</span>
          {fund.isLoading ? (
            <TerminalSkeletonLine className="w-20 h-4 mt-1" />
          ) : (
            <span className="text-sm font-semibold text-[color:var(--terminal-amber)]">
              {fund.pendingWithdrawsShares.toFixed(2)} shares
              <span className="text-[10px] text-[color:var(--terminal-amber-dim)] ml-1">
                ({fund.withdrawQueueLen})
              </span>
            </span>
          )}
        </div>
        <div className="terminal-border-inset p-2">
          <span className="text-[10px] text-[color:var(--terminal-amber-dim)] block">DEPLOYED_TO_L1</span>
          {fund.isLoading ? (
            <TerminalSkeletonLine className="w-20 h-4 mt-1" />
          ) : (
            <span className="text-sm font-semibold text-[color:var(--terminal-amber)]">
              ${fund.deployedToL1.toFixed(2)}
            </span>
          )}
        </div>
      </div>

      {/* User's pending requests */}
      {address && (
        <UserPendingRequests
          address={address}
          depositQueueHead={fund.depositQueueHead}
          depositQueueLen={fund.depositQueueLen}
          withdrawQueueLen={fund.withdrawQueueLen}
        />
      )}

      {!hasQueue && !fund.isLoading && !address && (
        <div className="mt-3 text-[10px] text-[color:var(--terminal-amber-dim)] text-center py-2">
          NO_PENDING_REQUESTS
        </div>
      )}
    </div>
  )
}

function UserPendingRequests({
  address,
  depositQueueHead,
  depositQueueLen,
  withdrawQueueLen,
}: {
  address: `0x${string}`
  depositQueueHead: number
  depositQueueLen: number
  withdrawQueueLen: number
}) {
  const cancelDeposit = useCancelDeposit()
  const cancelWithdraw = useCancelWithdraw()

  // Build batch read calls for unsettled deposit queue entries
  const depositCalls = useMemo(() => {
    if (!VAULT_ADDRESS || depositQueueLen <= depositQueueHead) return []
    return Array.from({ length: depositQueueLen - depositQueueHead }, (_, i) => ({
      address: VAULT_ADDRESS!,
      abi: vault4FundAbi,
      functionName: "getDepositRequest" as const,
      args: [BigInt(depositQueueHead + i)] as const,
    }))
  }, [depositQueueHead, depositQueueLen])

  // Build batch read calls for withdraw queue entries
  const withdrawCalls = useMemo(() => {
    if (!VAULT_ADDRESS || withdrawQueueLen <= 0) return []
    return Array.from({ length: withdrawQueueLen }, (_, i) => ({
      address: VAULT_ADDRESS!,
      abi: vault4FundAbi,
      functionName: "getWithdrawRequest" as const,
      args: [BigInt(i)] as const,
    }))
  }, [withdrawQueueLen])

  const { data: depositData } = useReadContracts({
    contracts: depositCalls,
    query: { enabled: depositCalls.length > 0, refetchInterval: 15_000 },
  })

  const { data: withdrawData } = useReadContracts({
    contracts: withdrawCalls,
    query: { enabled: withdrawCalls.length > 0, refetchInterval: 15_000 },
  })

  // Filter for user's requests with non-zero amounts
  const userRequests = useMemo(() => {
    const requests: PendingRequest[] = []

    depositData?.forEach((entry, i) => {
      if (entry.status !== "success" || !entry.result) return
      const [investor, assets, requestedAt] = entry.result as [string, bigint, bigint]
      if (investor.toLowerCase() !== address.toLowerCase()) return
      if (assets === 0n) return
      requests.push({
        type: "deposit",
        index: depositQueueHead + i,
        amount: Number(formatUnits(assets, 6)),
        requestedAt: Number(requestedAt),
      })
    })

    withdrawData?.forEach((entry, i) => {
      if (entry.status !== "success" || !entry.result) return
      const [investor, shares, requestedAt] = entry.result as [string, bigint, bigint]
      if (investor.toLowerCase() !== address.toLowerCase()) return
      if (shares === 0n) return
      requests.push({
        type: "withdraw",
        index: i,
        amount: Number(formatUnits(shares, 6)),
        requestedAt: Number(requestedAt),
      })
    })

    return requests
  }, [depositData, withdrawData, address, depositQueueHead])

  if (userRequests.length === 0) return null

  return (
    <div className="mt-3 pt-2 border-t border-[color:var(--terminal-amber-dim)]">
      <span className="text-[10px] text-[color:var(--terminal-amber)] font-semibold tracking-wider block mb-2">
        YOUR PENDING:
      </span>
      <div className="space-y-1.5">
        {userRequests.map((req) => {
          const isCancelling =
            (req.type === "deposit" && (cancelDeposit.isPending || cancelDeposit.isConfirming)) ||
            (req.type === "withdraw" && (cancelWithdraw.isPending || cancelWithdraw.isConfirming))

          return (
            <div
              key={`${req.type}-${req.index}`}
              className="flex items-center justify-between text-[10px] terminal-border-inset p-1.5"
            >
              <div className="flex items-center gap-2">
                <span className="text-[color:var(--terminal-amber)]">{">"}</span>
                <span className={req.type === "deposit" ? "text-[color:var(--terminal-green)]" : "text-[color:var(--terminal-cyan)]"}>
                  {req.type === "deposit" ? "DEPOSIT" : "WITHDRAW"}
                </span>
                <span className="text-[color:var(--terminal-amber)]">
                  {req.type === "deposit" ? `$${req.amount.toFixed(2)} USDC` : `${req.amount.toFixed(2)} shares`}
                </span>
                <span className="text-muted-foreground">
                  {formatTimeAgo(req.requestedAt)}
                </span>
              </div>
              <button
                onClick={() => {
                  if (req.type === "deposit") {
                    cancelDeposit.cancel(BigInt(req.index))
                  } else {
                    cancelWithdraw.cancel(BigInt(req.index))
                  }
                }}
                disabled={isCancelling}
                className="text-destructive hover:text-destructive/80 transition-colors font-semibold"
              >
                {isCancelling ? "[...]" : "[CANCEL]"}
              </button>
            </div>
          )
        })}
      </div>
      {(cancelDeposit.isSuccess || cancelWithdraw.isSuccess) && (
        <div className="mt-1.5 text-[10px] text-[color:var(--terminal-green-bright)]">
          REQUEST_CANCELLED
        </div>
      )}
    </div>
  )
}

function formatTimeAgo(unixSeconds: number): string {
  if (!unixSeconds) return ""
  const diffMs = Date.now() - unixSeconds * 1000
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
