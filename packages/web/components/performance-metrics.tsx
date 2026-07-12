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
      title: "Total capital: vault equities + wallet cash awaiting redeployment",
      value: formatUsd(tvl),
      sub: pending != null && pending >= 1 ? `incl. $${pending.toFixed(0)} pending deploy` : null,
      negative: false,
    },
    {
      label: "PNL",
      value: formatPercentSigned(pnlValue),
      sub: epoch?.mtm?.pnlUsd != null ? formatUsdSigned(epoch.mtm.pnlUsd) : null,
      negative: (pnlRaw ?? 0) < 0,
      switcher: true,
    },
    {
      label: "MAX_DRAWDOWN",
      title: "Peak-to-trough decline of account value since the epoch start",
      value: formatPercentSigned(epoch?.mtm?.maxDrawdownPct ?? null),
      negative: true,
    },
    {
      label: "WIN_RATE",
      title: "Wins / decisive closes — trades the current strategy opened and closed",
      value: formatPercent(stats?.winRatePct),
      negative: false,
    },
    {
      label: "REALIZED_PNL",
      title: "Realized PnL of closed strategy trades (open positions not included)",
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
      label: "EXPECTANCY",
      title: "Average realized $ per closed trade",
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
      title: "Average win vs average loss",
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

      {awaitingFirstCloses && (
        <p className="text-[10px] text-[color:var(--terminal-amber)] mt-2">
          AWAITING_FIRST_CLOSED_TRADES — trade stats populate as strategy positions close
        </p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-3">
        {items.map((metric) => (
          <div
            key={metric.label}
            className={`terminal-border-inset p-2 metric-card ${metric.negative ? "metric-card-negative" : ""}`}
          >
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
                title={metric.title}
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
