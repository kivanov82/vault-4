"use client"

import { useQuery } from "@tanstack/react-query"
import { BlinkingLabel } from "./blinking-label"
import { TerminalSkeletonLine } from "./terminal-skeleton"
import { ConnectionError } from "./connection-error"

type PositionsResponse = {
  totalPositions: number
  totalCapitalUsd: number | null
  totalInvestedUsd: number | null
  netPnlUsd: number | null
  positions: { amountUsd: number | null; pnlUsd: number | null }[]
}

const API_BASE = process.env.NEXT_PUBLIC_VAULT_API_BASE_URL ?? "http://localhost:3000"

export function AccountStats() {
  const { data, isLoading: loading, isError, refetch } = useQuery<PositionsResponse>({
    queryKey: ["positions"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/positions`)
      if (!res.ok) throw new Error("API error")
      return res.json()
    },
  })

  const totalInvested = data?.totalInvestedUsd ?? 0
  const netPnl = data?.netPnlUsd ?? 0
  const totalEquity = totalInvested + netPnl
  const roePct = totalInvested > 0 ? (netPnl / totalInvested) * 100 : 0

  if (isError && !data) {
    return <ConnectionError onRetry={() => refetch()} />
  }

  return (
    <div className="terminal-border-cyan p-3">
      <BlinkingLabel text="ACCOUNT_OVERVIEW" prefix="//" color="cyan" />

      <div className="mt-3 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1">
          {loading ? (
            <TerminalSkeletonLine variant="cyan" className="w-40 h-8" />
          ) : (
            <span className="text-2xl md:text-3xl font-bold glow-text-cyan text-[color:var(--terminal-cyan)]">
              {formatUsd(totalEquity)}
            </span>
          )}
          {loading ? (
            <TerminalSkeletonLine variant="cyan" className="w-32 h-4" />
          ) : (
            <span className={`text-sm ${netPnl >= 0 ? "text-[color:var(--terminal-green-bright)]" : "text-destructive"}`}>
              {`${formatUsdSigned(netPnl)} (${formatPercentSigned(roePct)})`}
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 sm:gap-3 text-xs">
          <div className="terminal-border-inset p-2">
            <span className="text-[color:var(--terminal-cyan-dim)] block text-[10px]">INVESTED</span>
            {loading ? (
              <TerminalSkeletonLine variant="cyan" className="w-20 h-4 mt-1" />
            ) : (
              <span className="text-[color:var(--terminal-cyan)] font-semibold">
                {formatUsd(totalInvested)}
              </span>
            )}
          </div>
          <div className="terminal-border-inset p-2">
            <span className="text-[color:var(--terminal-cyan-dim)] block text-[10px]">NET_PNL</span>
            {loading ? (
              <TerminalSkeletonLine variant="cyan" className="w-16 h-4 mt-1" />
            ) : (
              <span className={`font-semibold ${netPnl >= 0 ? "text-[color:var(--terminal-green-bright)]" : "text-destructive"}`}>
                {formatUsdSigned(netPnl)}
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

function formatUsdSigned(value: number) {
  const prefix = value >= 0 ? "+" : ""
  return `${prefix}$${Math.abs(value).toFixed(2)}`
}

function formatPercentSigned(value: number) {
  const prefix = value >= 0 ? "+" : ""
  return `${prefix}${Math.abs(value).toFixed(2)}%`
}
