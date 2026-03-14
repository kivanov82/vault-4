"use client"

import { BlinkingLabel } from "./blinking-label"
import { TerminalSkeletonLine } from "./terminal-skeleton"
import { useFundState } from "@/hooks/useVault4Fund"

export function FundMetrics() {
  const fund = useFundState()

  if (!fund.configured) return null

  const tvlTotal = fund.tvl + fund.pendingDepositsUsdc
  const items = [
    { label: "TVL", value: tvlTotal, format: formatUsd, sub: fund.pendingDepositsUsdc > 0 ? `+${formatUsd(fund.pendingDepositsUsdc)} pending` : null },
    { label: "SHARE_PRICE", value: fund.sharePrice, format: formatSharePrice, sub: null },
    { label: "INSTANT_LIQ", value: fund.instantLiquidity, format: formatUsd, sub: null },
    { label: "EPOCH", value: fund.epoch, format: (v: number) => `#${v}`, sub: null },
  ]

  return (
    <div className="terminal-border-cyan p-3">
      <div className="flex items-center justify-between">
        <BlinkingLabel text="VAULT-4 FUND" prefix="$" color="cyan" />
        {fund.paused && (
          <span className="text-[10px] text-[color:var(--terminal-amber)] glow-text-amber tracking-wider">
            PAUSED
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
        {items.map((item) => (
          <div key={item.label} className="terminal-border-inset p-2">
            <span className="text-[10px] text-[color:var(--terminal-cyan-dim)] block">
              {item.label}
            </span>
            {fund.isLoading ? (
              <TerminalSkeletonLine variant="cyan" className="w-16 h-4 mt-1" />
            ) : (
              <>
                <span className="text-sm font-semibold text-[color:var(--terminal-cyan)] mt-0.5 block">
                  {item.format(item.value)}
                </span>
                {item.sub && (
                  <span className="text-[9px] text-[color:var(--terminal-amber-dim)] block">
                    {item.sub}
                  </span>
                )}
              </>
            )}
          </div>
        ))}
      </div>

      <div className="mt-2 flex items-center justify-between text-[10px] text-[color:var(--terminal-cyan-dim)]">
        <span>SETTLEMENT: DAILY 3PM CET</span>
        <span>FEE: 10% ON PROFIT (HWM)</span>
      </div>
    </div>
  )
}

function formatUsd(value: number) {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`
  return `$${value.toFixed(2)}`
}

function formatSharePrice(value: number) {
  return `$${value.toFixed(4)}`
}
