"use client"

import { useMemo } from "react"
import { useAccount, useReadContracts } from "wagmi"
import { formatUnits } from "viem"

import { BlinkingLabel } from "./blinking-label"
import { useFundState } from "@/hooks/useVault4Fund"
import { useCancelDeposit, useCancelWithdraw } from "@/hooks/useVault4FundWrite"
import { vault4FundAbi } from "@/lib/vault4fund-abi"

const VAULT_ADDRESS = process.env.NEXT_PUBLIC_VAULT4FUND_ADDRESS as `0x${string}` | undefined

/** Scan a queue range and return entries belonging to the connected address */
function useUserQueueEntries(
  type: "deposit" | "withdraw",
  queueHead: number,
  queueLen: number,
  address: `0x${string}` | undefined,
) {
  const calls = useMemo(() => {
    if (!VAULT_ADDRESS || !address || queueLen <= queueHead) return []
    const fn = type === "deposit" ? "getDepositRequest" : "getWithdrawRequest"
    return Array.from({ length: queueLen - queueHead }, (_, i) => ({
      address: VAULT_ADDRESS!,
      abi: vault4FundAbi,
      functionName: fn as "getDepositRequest",
      args: [BigInt(queueHead + i)] as const,
    }))
  }, [queueHead, queueLen, type, address])

  const { data } = useReadContracts({
    contracts: calls,
    query: { enabled: calls.length > 0, refetchInterval: 15_000 },
  })

  return useMemo(() => {
    const entries: { index: number; amount: bigint }[] = []
    if (!address) return entries
    data?.forEach((entry, i) => {
      if (entry.status !== "success" || !entry.result) return
      const [investor, amount] = entry.result as [string, bigint, bigint]
      if (investor.toLowerCase() !== address.toLowerCase()) return
      if (amount === 0n) return
      entries.push({ index: queueHead + i, amount })
    })
    return entries
  }, [data, address, queueHead])
}

export function QueueStatus() {
  const fund = useFundState()
  const { address } = useAccount()
  const cancelDeposit = useCancelDeposit()
  const cancelWithdraw = useCancelWithdraw()

  const userDeposits = useUserQueueEntries("deposit", fund.depositQueueHead, fund.depositQueueLen, address)
  const userWithdraws = useUserQueueEntries("withdraw", 0, fund.withdrawQueueLen, address)

  if (!fund.configured || !address) return null

  const userDepositUsdc = userDeposits.reduce((sum, e) => sum + Number(formatUnits(e.amount, 6)), 0)
  const userWithdrawShares = userWithdraws.reduce((sum, e) => sum + Number(formatUnits(e.amount, 6)), 0)

  if (userDeposits.length === 0 && userWithdraws.length === 0) return null

  const isCancelling = cancelDeposit.isPending || cancelDeposit.isConfirming ||
    cancelWithdraw.isPending || cancelWithdraw.isConfirming

  return (
    <div className="terminal-border-amber p-3">
      <BlinkingLabel text="PENDING REQUESTS" prefix="!" color="amber" as="h2" />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3">
        {userDeposits.length > 0 && (
          <div className="terminal-border-inset p-2">
            <span className="text-[10px] text-[color:var(--terminal-amber-dim)] block">PENDING_DEPOSITS</span>
            <div className="flex items-center justify-between mt-0.5">
              <span className="text-sm font-semibold text-[color:var(--terminal-amber)]">
                ${userDepositUsdc.toFixed(2)}
              </span>
              <div className="flex gap-1">
                {userDeposits.map((e) => (
                  <button
                    key={e.index}
                    onClick={() => cancelDeposit.cancel(BigInt(e.index))}
                    disabled={isCancelling}
                    className="text-[10px] text-destructive hover:text-destructive/80 transition-colors font-semibold"
                  >
                    {isCancelling ? "[...]" : "[CANCEL]"}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        {userWithdraws.length > 0 && (
          <div className="terminal-border-inset p-2">
            <span className="text-[10px] text-[color:var(--terminal-amber-dim)] block">PENDING_WITHDRAWALS</span>
            <div className="flex items-center justify-between mt-0.5">
              <span className="text-sm font-semibold text-[color:var(--terminal-amber)]">
                {userWithdrawShares.toFixed(2)} shares
              </span>
              <div className="flex gap-1">
                {userWithdraws.map((e) => (
                  <button
                    key={e.index}
                    onClick={() => cancelWithdraw.cancel(BigInt(e.index))}
                    disabled={isCancelling}
                    className="text-[10px] text-destructive hover:text-destructive/80 transition-colors font-semibold"
                  >
                    {isCancelling ? "[...]" : "[CANCEL]"}
                  </button>
                ))}
              </div>
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
