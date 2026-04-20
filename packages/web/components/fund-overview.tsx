"use client"

import { useAccount } from "wagmi"
import { BlinkingLabel } from "./blinking-label"
import { TerminalSkeletonLine } from "./terminal-skeleton"
import { useFundState, useInvestorState } from "@/hooks/useVault4Fund"

export function FundOverview() {
  const { isConnected } = useAccount()
  const fund = useFundState()
  const investor = useInvestorState()

  if (!fund.configured) return null

  const yourValue = investor.shares * fund.sharePrice
  const loading = fund.isLoading || (isConnected && investor.isLoading)

  return (
    <div className="terminal-border-cyan p-3">
      <BlinkingLabel text="MY_HOLDINGS" prefix="//" color="cyan" as="h2" />

      <div className="mt-3 space-y-3">
        {/* Your position (only when connected and has shares) */}
        {isConnected && investor.shares > 0 && (
          <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1">
            {loading ? (
              <TerminalSkeletonLine variant="cyan" className="w-40 h-8" />
            ) : (
              <span className="text-2xl md:text-3xl font-bold glow-text-cyan text-[color:var(--terminal-cyan)]">
                {formatUsd(yourValue)}
              </span>
            )}
          </div>
        )}

        {/* Fund stats */}
        <div className="grid grid-cols-3 gap-2 sm:gap-3 text-xs">
          <div className="terminal-border-inset p-2">
            <span className="text-[color:var(--terminal-cyan-dim)] block text-[10px]">INSTANT_LIQ</span>
            {loading ? (
              <TerminalSkeletonLine variant="cyan" className="w-16 h-4 mt-1" />
            ) : (
              <span className="text-[color:var(--terminal-cyan)] font-semibold">
                {formatUsd(fund.instantLiquidity)}
              </span>
            )}
          </div>
          <div className="terminal-border-inset p-2">
            <span className="text-[color:var(--terminal-cyan-dim)] block text-[10px]">SHARE_PRICE</span>
            {loading ? (
              <TerminalSkeletonLine variant="cyan" className="w-16 h-4 mt-1" />
            ) : (
              <span className="text-[color:var(--terminal-cyan)] font-semibold">
                ${fund.sharePrice.toFixed(4)}
              </span>
            )}
          </div>
          <div className="terminal-border-inset p-2">
            <span className="text-[color:var(--terminal-cyan-dim)] block text-[10px]">EPOCH</span>
            {loading ? (
              <TerminalSkeletonLine variant="cyan" className="w-10 h-4 mt-1" />
            ) : (
              <span className="text-[color:var(--terminal-cyan)] font-semibold">
                {fund.epoch}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function formatUsd(value: number) {
  return `$${value.toFixed(2)}`
}

function formatShares(value: number) {
  return value.toFixed(2)
}
