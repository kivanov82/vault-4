"use client"

import { useEffect, useState } from "react"
import { BlinkingLabel } from "./blinking-label"

type PositionsResponse = {
  totalPositions: number
  totalCapitalUsd: number | null
  totalInvestedUsd: number | null
  netPnlUsd: number | null
  positions: { amountUsd: number | null; pnlUsd: number | null }[]
}

const API_BASE = process.env.NEXT_PUBLIC_VAULT_API_BASE_URL ?? "http://localhost:3000"

export function AccountStats() {
  const [data, setData] = useState<PositionsResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/positions`)
        if (!res.ok) return
        const payload = (await res.json()) as PositionsResponse
        if (active) setData(payload)
      } finally {
        if (active) setLoading(false)
      }
    }
    load()
    return () => { active = false }
  }, [])

  const totalInvested = data?.totalInvestedUsd ?? 0
  const netPnl = data?.netPnlUsd ?? 0
  const totalEquity = totalInvested + netPnl
  const roePct = totalInvested > 0 ? (netPnl / totalInvested) * 100 : 0

  return (
    <div className="terminal-border-cyan p-3">
      <BlinkingLabel text="ACCOUNT_OVERVIEW" prefix="//" color="cyan" />

      <div className="mt-3 space-y-3">
        <div className="flex items-baseline justify-between">
          <span className="text-2xl md:text-3xl font-bold glow-text-cyan text-[color:var(--terminal-cyan)]">
            {loading ? "..." : formatUsd(totalEquity)}
          </span>
          <span className={`text-sm ${netPnl >= 0 ? "text-[color:var(--terminal-green-bright)]" : "text-destructive"}`}>
            {loading ? "" : `${formatUsdSigned(netPnl)} (${formatPercentSigned(roePct)})`}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="terminal-border-inset p-2">
            <span className="text-[color:var(--terminal-cyan-dim)] block text-[10px]">INVESTED</span>
            <span className="text-[color:var(--terminal-cyan)] font-semibold">
              {loading ? "..." : formatUsd(totalInvested)}
            </span>
          </div>
          <div className="terminal-border-inset p-2">
            <span className="text-[color:var(--terminal-cyan-dim)] block text-[10px]">ACTIVE_VAULTS</span>
            <span className="text-[color:var(--terminal-cyan)] font-semibold">
              {loading ? "..." : String(data?.totalPositions ?? 0)}
            </span>
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
