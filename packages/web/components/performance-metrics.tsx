"use client"

import { useEffect, useState, useRef } from "react"
import { useQuery } from "@tanstack/react-query"
import { BlinkingLabel } from "./blinking-label"
import { TerminalSkeletonLine } from "./terminal-skeleton"
import { ConnectionError } from "./connection-error"
import { LAUNCH_DATE_ISO } from "@/lib/constants"

/**
 * Single performance panel, anchored to the strategy epoch (2026-07-09).
 * The track record shown here starts when the current strategy started —
 * headline PnL/drawdown are mark-to-market since the epoch (mtm block of
 * /api/metrics/epoch), trade stats are closesOriginated (positions the
 * current strategy opened AND closed). TVL is total capital (vault equities
 * + wallet cash awaiting redeployment) so it doesn't dip every time an exit
 * parks cash in the wallet for a round.
 */

type MetricsResponse = {
  tvlUsd: number | null
  totalCapitalUsd: number | null
  pendingDeployUsd: number | null
}

// Kept in sync with EpochKpis / EpochCloseStats / EpochMtm in
// packages/api/src/db/EpochKpiService.ts
type EpochCloseStats = {
  count: number
  wins: number
  losses: number
  flats: number
  winRatePct: number | null
  realizedPnlUsd: number
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
  mtm: {
    pnlUsd: number | null
    pnlPct: number | null
    maxDrawdownPct: number | null
    startEquityUsd: number | null
    currentEquityUsd: number | null
    asOf: string | null
  }
  closesOriginated: EpochCloseStats
  closesInherited: EpochCloseStats
}

const API_BASE = process.env.NEXT_PUBLIC_VAULT_API_BASE_URL ?? "http://localhost:3000"

function useCountUp(target: number | null, duration = 1200) {
  const [value, setValue] = useState<number | null>(null)
  const rafRef = useRef<number>(0)

  useEffect(() => {
    if (target === null) { setValue(null); return }
    const start = performance.now()
    const from = 0
    const animate = (now: number) => {
      const elapsed = now - start
      const progress = Math.min(elapsed / duration, 1)
      const eased = 1 - Math.pow(1 - progress, 3)
      setValue(from + (target - from) * eased)
      if (progress < 1) rafRef.current = requestAnimationFrame(animate)
    }
    rafRef.current = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(rafRef.current)
  }, [target, duration])

  return value
}

type PnlMode = "EPOCH" | "ANNUAL"

const MODE_TOOLTIPS: Record<PnlMode, string> = {
  EPOCH: "Mark-to-market PnL (realized + unrealized) since the strategy epoch start",
  ANNUAL: "Epoch-to-date MTM PnL compounded to a 365-day rate — noisy while the epoch is young",
}

export function PerformanceMetrics() {
  const [pnlMode, setPnlMode] = useState<PnlMode>("EPOCH")

  const { data: metrics, isError: metricsError, refetch: refetchMetrics } = useQuery<MetricsResponse>({
    queryKey: ["metrics"],
    queryFn: async () => {
      const response = await fetch(`${API_BASE}/api/metrics`)
      if (!response.ok) throw new Error("API error")
      return response.json()
    },
  })
  const { data: epoch, isLoading: epochLoading, isError: epochError, refetch: refetchEpoch } = useQuery<EpochKpisResponse>({
    queryKey: ["metrics-epoch"],
    queryFn: async () => {
      const response = await fetch(`${API_BASE}/api/metrics/epoch`)
      if (!response.ok) throw new Error("API error")
      return response.json()
    },
  })

  if (metricsError && epochError && !metrics && !epoch) {
    return <ConnectionError onRetry={() => { refetchMetrics(); refetchEpoch() }} />
  }

  const loading = epochLoading && !epoch
  const stats = epoch?.closesOriginated
  const inherited = epoch?.closesInherited
  const epochDate = (epoch?.epochStart ?? LAUNCH_DATE_ISO).slice(0, 10)
  const days = epoch?.days ?? null
  const awaitingFirstCloses = stats != null && stats.count === 0

  const capitalRaw = metrics?.totalCapitalUsd ?? metrics?.tvlUsd ?? null
  const pending = metrics?.pendingDeployUsd ?? null
  const tvl = useCountUp(capitalRaw)

  const epochPnlRaw = epoch?.mtm?.pnlPct ?? null
  const annualRaw =
    epochPnlRaw != null && days != null && days >= 1
      ? compoundAnnualize(epochPnlRaw, days)
      : null
  const epochPnl = useCountUp(epochPnlRaw)
  const annual = useCountUp(annualRaw)
  const pnlValue = pnlMode === "EPOCH" ? epochPnl : annual
  const pnlRaw = pnlMode === "EPOCH" ? epochPnlRaw : annualRaw

  const items: Array<{
    label: string
    title?: string
    value: string | null
    sub?: string | null
    negative: boolean
    switcher?: boolean
  }> = [
    {
      label: "TVL",
      title: "Total capital under management: funds deployed into vaults plus cash between deployments (shown as pending). Includes profits.",
      value: formatUsd(tvl),
      sub: pending != null && pending >= 1 ? `incl. $${pending.toFixed(0)} pending deploy` : null,
      negative: false,
    },
    {
      label: "PNL",
      title: "Strategy profit & loss since the epoch start, marked to market (realized + unrealized). [EPOCH] shows the raw figure; [ANNUAL] compounds it to a yearly rate — noisy while the track record is young.",
      value: formatPercentSigned(pnlValue),
      sub: epoch?.mtm?.pnlUsd != null ? formatUsdSigned(epoch.mtm.pnlUsd) : null,
      negative: (pnlRaw ?? 0) < 0,
      switcher: true,
    },
    {
      label: "MAX_DRAWDOWN",
      title: "Worst peak-to-trough decline of the strategy's value since the epoch start. Smaller is better.",
      value: formatPercentSigned(epoch?.mtm?.maxDrawdownPct ?? null),
      negative: true,
    },
    {
      label: "WIN_RATE",
      title: "Share of closed trades that ended profitable. Counts only trades the current strategy opened and closed.",
      value: formatPercent(stats?.winRatePct),
      negative: false,
    },
    {
      label: "REALIZED_PNL",
      title: "Profit locked in from closed strategy trades. Gains on still-open positions are not included here — they show in PNL.",
      value: stats ? (stats.count > 0 ? formatUsdSigned(stats.realizedPnlUsd) : "--") : null,
      negative: (stats?.realizedPnlUsd ?? 0) < 0,
    },
    {
      label: "CLOSES",
      title: "Completed round-trip trades (wins/losses) by the current strategy. Open positions don't count until they close.",
      value: stats ? `${stats.count} (${stats.wins}W/${stats.losses}L)` : null,
      negative: false,
    },
    {
      label: "EXPECTANCY",
      title: "Average profit per closed trade. Positive means the strategy makes money on a typical trade.",
      value: stats ? formatUsdSigned(stats.expectancyUsdPerClose) : null,
      negative: (stats?.expectancyUsdPerClose ?? 0) < 0,
    },
    {
      label: "PROFIT_FACTOR",
      title: "Total gross profits divided by total gross losses on closed trades. Above 1.00 = profitable.",
      value: formatRatio(stats?.profitFactor),
      negative: stats?.profitFactor != null && stats.profitFactor < 1,
    },
    {
      label: "AVG_WIN/LOSS",
      title: "Average winning trade divided by average losing trade. Above 1.00 means wins are bigger than losses.",
      value: formatRatio(stats?.winLossRatio),
      negative: stats?.winLossRatio != null && stats.winLossRatio < 1,
    },
  ]

  return (
    <div className="terminal-border p-3">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <BlinkingLabel text="PERFORMANCE_METRICS" prefix="$" color="cyan" as="h2" />
        <span className="text-[10px] text-[color:var(--terminal-cyan-dim)]">
          SINCE {epochDate}{days != null ? ` // D+${Math.floor(days)}` : ""}
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-3">
        {items.map((metric) => (
          <div
            key={metric.label}
            tabIndex={metric.title ? 0 : undefined}
            className={`relative group terminal-border-inset p-2 metric-card outline-none ${metric.negative ? "metric-card-negative" : ""}`}
          >
            {metric.title && (
              <div
                role="tooltip"
                className="pointer-events-none absolute inset-x-0 bottom-full mb-1 z-20 border border-[color:var(--terminal-cyan-dim)] bg-black/95 p-2 text-[10px] leading-relaxed text-[color:var(--terminal-cyan)] opacity-0 translate-y-1 transition-all duration-150 delay-150 group-hover:opacity-100 group-hover:translate-y-0 group-focus-within:opacity-100 group-focus-within:translate-y-0"
              >
                {metric.title}
              </div>
            )}
            {metric.switcher ? (
              <div className="flex items-center gap-1 text-[10px]">
                <span className="text-[color:var(--terminal-cyan-dim)]">PnL:</span>
                {(["EPOCH", "ANNUAL"] as const).map((mode, i) => (
                  <span key={mode} className="flex items-center gap-1">
                    {i > 0 && <span className="text-[color:var(--terminal-cyan-dim)]">/</span>}
                    <button
                      onClick={() => setPnlMode(mode)}
                      title={MODE_TOOLTIPS[mode]}
                      className={`transition-all cursor-help ${
                        pnlMode === mode
                          ? "text-[color:var(--terminal-cyan)]"
                          : "text-[color:var(--terminal-cyan-dim)] hover:text-[color:var(--terminal-cyan)]"
                      }`}
                    >
                      [{mode}]
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <span
                className={`text-[10px] text-[color:var(--terminal-cyan-dim)] block truncate ${metric.title ? "cursor-help" : ""}`}
              >
                {metric.label}
              </span>
            )}
            <div className="flex items-baseline gap-2 mt-1">
              {loading && metric.value == null ? (
                <TerminalSkeletonLine className="w-16 h-4" />
              ) : (
                <span className="text-sm font-semibold text-primary">{metric.value ?? "--"}</span>
              )}
              {metric.sub && (
                <span className="text-[9px] text-muted-foreground truncate">{metric.sub}</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {(awaitingFirstCloses || (inherited != null && inherited.count > 0)) && (
        <p
          className="text-[10px] text-[color:var(--terminal-cyan-dim)] mt-2"
          title="Trade stats cover only positions the current strategy opened and closed; pre-epoch exits are cleanup, not attributed to it"
        >
          {awaitingFirstCloses && "no closed trades yet — stats populate as positions close"}
          {awaitingFirstCloses && inherited != null && inherited.count > 0 && " · "}
          {inherited != null && inherited.count > 0 &&
            `pre-epoch cleanup: ${inherited.count} closes, ${formatUsdSigned(inherited.realizedPnlUsd)} (not attributed)`}
        </p>
      )}
    </div>
  )
}

function formatUsd(value?: number | null) {
  if (value === undefined || value === null) return "--"
  return `$${value.toFixed(2)}`
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

function formatPercentSigned(value?: number | null) {
  if (value === undefined || value === null) return "--"
  const prefix = value >= 0 ? "+" : "-"
  return `${prefix}${Math.abs(value).toFixed(2)}%`
}

function formatRatio(value?: number | null) {
  if (value === undefined || value === null) return "--"
  return value.toFixed(2)
}

function compoundAnnualize(pct: number, days: number): number {
  if (!Number.isFinite(pct) || !Number.isFinite(days) || days <= 0) return pct
  const ratio = 1 + pct / 100
  if (ratio <= 0) return -100
  return (Math.pow(ratio, 365 / days) - 1) * 100
}
