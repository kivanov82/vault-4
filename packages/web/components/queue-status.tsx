"use client"

import { useMemo } from "react"
import { useAccount, useReadContracts } from "wagmi"

import { BlinkingLabel } from "./blinking-label"
import { TerminalSkeletonLine } from "./terminal-skeleton"
import { useFundState } from "@/hooks/useVault4Fund"
import { useCancelDeposit, useCancelWithdraw } from "@/hooks/useVault4FundWrite"
import { vault4FundAbi } from "@/lib/vault4fund-abi"

const VAULT_ADDRESS = process.env.NEXT_PUBLIC_VAULT4FUND_ADDRESS as `0x${string}` | undefined

export function QueueStatus() {
  const fund = useFundState()
  const { address } = useAccount()
  const cancelDeposit = useCancelDeposit()
  const cancelWithdraw = useCancelWithdraw()

  if (!fund.configured) return null

  const hasQueue = fund.pendingDepositsUsdc > 0 || fund.pendingWithdrawsShares > 0

  if (!hasQueue && !fund.isLoading) return null

  return (
    <div className="terminal-border-amber p-3">
      <BlinkingLabel text="PENDING REQUESTS" prefix="!" color="amber" />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3">
        {fund.pendingDepositsUsdc > 0 && (
          <div className="terminal-border-inset p-2">
            <span className="text-[10px] text-[color:var(--terminal-amber-dim)] block">PENDING_DEPOSITS</span>
            <div className="flex items-center justify-between mt-0.5">
              <span className="text-sm font-semibold text-[color:var(--terminal-amber)]">
                ${fund.pendingDepositsUsdc.toFixed(2)}
              </span>
              {address && (
                <UserCancelButtons
                  address={address}
                  type="deposit"
                  queueHead={fund.depositQueueHead}
                  queueLen={fund.depositQueueLen}
                  cancel={cancelDeposit}
                />
              )}
            </div>
          </div>
        )}
        {fund.pendingWithdrawsShares > 0 && (
          <div className="terminal-border-inset p-2">
            <span className="text-[10px] text-[color:var(--terminal-amber-dim)] block">PENDING_WITHDRAWALS</span>
            <div className="flex items-center justify-between mt-0.5">
              <span className="text-sm font-semibold text-[color:var(--terminal-amber)]">
                {fund.pendingWithdrawsShares.toFixed(2)} shares
              </span>
              {address && (
                <UserCancelButtons
                  address={address}
                  type="withdraw"
                  queueHead={0}
                  queueLen={fund.withdrawQueueLen}
                  cancel={cancelWithdraw}
                />
              )}
            </div>
          </div>
        )}
      </div>

      {(cancelDeposit.isSuccess || cancelWithdraw.isSuccess) && (
        <div className="mt-2 text-[10px] text-[color:var(--terminal-green-bright)]">
          REQUEST_CANCELLED
        </div>
      )}
    </div>
  )
}

function UserCancelButtons({
  address,
  type,
  queueHead,
  queueLen,
  cancel,
}: {
  address: `0x${string}`
  type: "deposit" | "withdraw"
  queueHead: number
  queueLen: number
  cancel: ReturnType<typeof useCancelDeposit>
}) {
  const calls = useMemo(() => {
    if (!VAULT_ADDRESS || queueLen <= queueHead) return []
    const fn = type === "deposit" ? "getDepositRequest" : "getWithdrawRequest"
    return Array.from({ length: queueLen - queueHead }, (_, i) => ({
      address: VAULT_ADDRESS!,
      abi: vault4FundAbi,
      functionName: fn as "getDepositRequest",
      args: [BigInt(queueHead + i)] as const,
    }))
  }, [queueHead, queueLen, type])

  const { data } = useReadContracts({
    contracts: calls,
    query: { enabled: calls.length > 0, refetchInterval: 15_000 },
  })

  const userIndices = useMemo(() => {
    const indices: number[] = []
    data?.forEach((entry, i) => {
      if (entry.status !== "success" || !entry.result) return
      const [investor, amount] = entry.result as [string, bigint, bigint]
      if (investor.toLowerCase() !== address.toLowerCase()) return
      if (amount === 0n) return
      indices.push(queueHead + i)
    })
    return indices
  }, [data, address, queueHead])

  if (userIndices.length === 0) return null

  const isCancelling = cancel.isPending || cancel.isConfirming

  return (
    <div className="flex gap-1">
      {userIndices.map((idx) => (
        <button
          key={idx}
          onClick={() => cancel.cancel(BigInt(idx))}
          disabled={isCancelling}
          className="text-[10px] text-destructive hover:text-destructive/80 transition-colors font-semibold"
        >
          {isCancelling ? "[...]" : "[CANCEL]"}
        </button>
      ))}
    </div>
  )
}
