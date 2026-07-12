"use client"

import { useQuery } from "@tanstack/react-query"
import { BlinkingLabel } from "./blinking-label"
import { TerminalSkeletonLine } from "./terminal-skeleton"

// Kept in sync with EpochCloseStats / EpochKpis in packages/api/src/db/EpochKpiService.ts
type EpochCloseStats = {
  count: number
  wins: number
  losses: number
  flats: number
  winRatePct: number | null
  realizedPnlUsd: number
  grossWinsUsd: number
  grossLossesUsd: number
  avgWinUsd: number | null
  avgLossUsd: number | null
  winLossRatio: number | null
  profitFactor: number | null
  expectancyUsdPerClose: number | null
  churn: { count: number; lossUsd: number }
}

type EpochKpisResponse = {
  epochStart: string
  days: number
  closes: EpochCloseStats
  closesOriginated: EpochCloseStats
  closesInherited: EpochCloseStats
}

const API_BASE = process.env.NEXT_PUBLIC_VAULT_API_BASE_URL ?? "http://localhost:3000"

/**
 * Current-strategy scoreboard. The PERFORMANCE_METRICS panel above shows
 * lifetime numbers, which include everything the strategy no longer is
 * (pre-overhaul eras, incidents). This panel shows only trades the CURRENT
 * strategy opened AND closed since the epoch start (`closesOriginated` from
 * /api/metrics/epoch) — the same scoreboard the go/no-go review uses.
 * Closes of inventory inherited from before the epoch are summarized in a
 * footnote so the two views reconcile, and neither replaces the other.
 */
export function StrategyEpochMetrics() {
  const { data, isLoading } = useQuery<EpochKpisResponse>({
    queryKey: ["metrics-epoch"],
    queryFn: async () => {
      const response = await fetch(`${API_BASE}/api/metrics/epoch`)
      if (!response.ok) throw new Error("API error")
      return response.json()
    },
  })

  // Secondary panel: if the trace DB is unavailable, disappear quietly
  // rather than block the dashboard with an error box.
  if (!isLoading && !data) return null

  const stats = data?.closesOriginated
  const inherited = data?.closesInherited
  const epochDate = data ? data.epochStart.slice(0, 10) : null
  const awaitingFirstCloses = stats != null && stats.count === 0

  const items = [
    {
      label: "REALIZED_PNL",
      title: "Realized PnL of positions the current strategy opened and closed",
      value: stats ? formatUsdSigned(stats.realizedPnlUsd) : null,
      negative: (stats?.realizedPnlUsd ?? 0) < 0,
    },
    {
      label: "CLOSES",
      title: "Closed trades (wins/losses) originated by the current strategy",
      value: stats ? `${stats.count} (${stats.wins}W/${stats.losses}L)` : null,
      negative: false,
    },
    {
      label: "WIN_RATE",
      title: "Wins / decisive closes",
      value: formatPercent(stats?.winRatePct),
      negative: false,
    },
    {
      label: "EXPECTANCY",
      title: "Average realized $ per closed trade — the go/no-go bar is > 0",
      value: stats ? formatUsdSigned(stats.expectancyUsdPerClose) : null,
      negative: (stats?.expectancyUsdPerClose ?? 0) < 0,
    },
    {
      label: "PROFIT_FACTOR",
      title: "Gross wins / gross losses",
      value: formatRatio(stats?.profitFactor),
      negative: stats?.profitFactor != null && stats.profitFactor < 1,
    },
    {
      label: "AVG_WIN/LOSS",
      title: "Average win vs average loss — the go/no-go bar is a ratio ≥ 1",
      value: formatRatio(stats?.winLossRatio),
      negative: stats?.winLossRatio != null && stats.winLossRatio < 1,
    },
  ]

  return (
    <div className="terminal-border p-3">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <BlinkingLabel text="STRATEGY_EPOCH" prefix="::" color="green" as="h2" />
        <span className="text-[10px] text-[color:var(--terminal-cyan-dim)]">
          {epochDate ? `CURRENT STRATEGY ONLY // SINCE ${epochDate} // D+${data ? Math.floor(data.days) : 0}` : ""}
        </span>
      </div>

      {awaitingFirstCloses && (
        <p className="text-[10px] text-[color:var(--terminal-amber)] mt-2">
          AWAITING_FIRST_CLOSED_TRADES — all current-strategy positions are still open
        </p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-3">
        {items.map((metric) => (
          <div
            key={metric.label}
            className={`terminal-border-inset p-2 metric-card ${metric.negative ? "metric-card-negative" : ""}`}
          >
            <span
              title={metric.title}
              className="text-[10px] text-[color:var(--terminal-cyan-dim)] block truncate cursor-help"
            >
              {metric.label}
            </span>
            <div className="flex items-baseline gap-2 mt-1">
              {isLoading ? (
                <TerminalSkeletonLine className="w-16 h-4" />
              ) : (
                <span className="text-sm font-semibold text-primary">{metric.value ?? "--"}</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {inherited != null && inherited.count > 0 && (
        <p
          className="text-[10px] text-[color:var(--terminal-cyan-dim)] mt-2"
          title="Exits of positions opened before the epoch start — cleanup, not attributed to the current strategy"
        >
          + pre-epoch inventory cleanup: {inherited.count} closes, {formatUsdSigned(inherited.realizedPnlUsd)} (not attributed)
        </p>
      )}
    </div>
  )
}

function formatUsdSigned(value?: number | null) {
  if (value === undefined || value === null) return "--"
  const prefix = value >= 0 ? "+" : "-"
  return `${prefix}$${Math.abs(value).toFixed(2)}`
}

function formatPercent(value?: number | null) {
  if (value === undefined || value === null) return "--"
  return `${value.toFixed(1)}%`
}

function formatRatio(value?: number | null) {
  if (value === undefined || value === null) return "--"
  return value.toFixed(2)
}
