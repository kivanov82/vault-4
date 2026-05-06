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
  const hasShares = isConnected && investor.shares > 0

  return (
    <div className="terminal-border-cyan p-3 sm:p-4">
      <BlinkingLabel
        text={hasShares ? "MY_HOLDINGS" : "FUND_STATUS"}
        prefix="//"
        color="cyan"
        as="h2"
      />

      <div className="mt-3 space-y-3">
        {hasShares && (
          <div className="flex flex-col sm:flex-row sm:items-baseline sm:gap-3">
            {loading ? (
              <TerminalSkeletonLine variant="cyan" className="w-40 h-9" />
            ) : (
              <>
                <span className="text-2xl md:text-3xl font-bold glow-text-cyan text-[color:var(--terminal-cyan)]">
                  {formatUsd(yourValue)}
                </span>
                <span className="text-xs text-[color:var(--terminal-cyan-dim)]">
                  ({investor.shares.toFixed(2)} V4FUND)
                </span>
              </>
            )}
          </div>
        )}

        {/* Fund stats */}
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          <div
            className="terminal-border-inset p-2.5"
            title="USDC available for immediate withdrawal — no settlement wait"
          >
            <span className="text-[color:var(--terminal-cyan-dim)] block text-xs">
              INSTANT_LIQ
            </span>
            {loading ? (
              <TerminalSkeletonLine variant="cyan" className="w-16 h-5 mt-1" />
            ) : (
              <span className="text-sm sm:text-base text-[color:var(--terminal-cyan)] font-semibold">
                {formatUsd(fund.instantLiquidity)}
              </span>
            )}
          </div>
          <div
            className="terminal-border-inset p-2.5"
            title="Current value of one V4FUND share in USDC"
          >
            <span className="text-[color:var(--terminal-cyan-dim)] block text-xs">
              SHARE_PRICE
            </span>
            {loading ? (
              <TerminalSkeletonLine variant="cyan" className="w-16 h-5 mt-1" />
            ) : (
              <span className="text-sm sm:text-base text-[color:var(--terminal-cyan)] font-semibold">
                ${fund.sharePrice.toFixed(4)}
              </span>
            )}
          </div>
          <div
            className="terminal-border-inset p-2.5"
            title="Settlement cycle counter — increments at each 3PM CET fill"
          >
            <span className="text-[color:var(--terminal-cyan-dim)] block text-xs">
              EPOCH
            </span>
            {loading ? (
              <TerminalSkeletonLine variant="cyan" className="w-10 h-5 mt-1" />
            ) : (
              <span className="text-sm sm:text-base text-[color:var(--terminal-cyan)] font-semibold">
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
