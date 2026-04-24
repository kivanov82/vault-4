"use client"

import { useEffect, useState, useRef } from "react"
import { useQuery } from "@tanstack/react-query"
import { BlinkingLabel } from "./blinking-label"
import { TerminalSkeletonLine } from "./terminal-skeleton"
import { ConnectionError } from "./connection-error"

type MetricsResponse = {
  tvlUsd: number | null
  tvlChange30dUsd: number | null
  pnlChange30dPct: number | null
  pnlChange60dPct: number | null
  winRatePct: number | null
  maxDrawdownPct: number | null
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

type PnlMode = "ANNUALIZED" | "30D"

export function PerformanceMetrics() {
  const [pnlMode, setPnlMode] = useState<PnlMode>("ANNUALIZED")
  const { data: metrics, isLoading: loading, isError, refetch } = useQuery<MetricsResponse>({
    queryKey: ["metrics"],
    queryFn: async () => {
      const response = await fetch(`${API_BASE}/api/metrics`)
      if (!response.ok) throw new Error("API error")
      return response.json()
    },
  })
  const error = isError && !metrics

  const tvl = useCountUp(metrics?.tvlUsd ?? null)
  const annualizedRaw = metrics?.pnlChange60dPct != null
    ? metrics.pnlChange60dPct * 6
    : null
  const annualized = useCountUp(annualizedRaw)
  const pnl30d = useCountUp(metrics?.pnlChange30dPct ?? null)
  const drawdown = useCountUp(metrics?.maxDrawdownPct ?? null)
  const winRate = useCountUp(metrics?.winRatePct ?? null)

  const pnlValue = pnlMode === "ANNUALIZED" ? annualized : pnl30d
  const pnlRaw = pnlMode === "ANNUALIZED" ? annualizedRaw : (metrics?.pnlChange30dPct ?? null)

  const items = [
    {
      label: "TVL",
      value: formatUsd(tvl),
      change: null,
      changeValue: null,
      negative: false,
    },
    {
      label: pnlMode === "ANNUALIZED" ? "ANNUALIZED_PERF" : "30D_PERFORMANCE",
      value: formatPercentSigned(pnlValue),
      change: null,
      changeValue: null,
      negative: (pnlRaw ?? 0) < 0,
      switcher: true as const,
    },
    {
      label: "MAX_DRAWDOWN",
      value: formatPercentSigned(drawdown),
      change: null,
      changeValue: null,
      negative: true,
    },
    {
      label: "WIN_RATE_ALL",
      value: formatPercent(winRate),
      change: null,
      changeValue: null,
      negative: false,
    },
  ]

  if (error) {
    return <ConnectionError onRetry={() => refetch()} />
  }

  return (
    <div className="terminal-border p-3">
      <BlinkingLabel text="PERFORMANCE_METRICS" prefix="$" color="cyan" as="h2" />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3">
        {items.map((metric) => (
          <div
            key={metric.label}
            className={`terminal-border-inset p-2 metric-card ${metric.negative ? "metric-card-negative" : ""}`}
          >
            {"switcher" in metric && metric.switcher ? (
              <div className="flex items-center gap-1 text-[10px]">
                <button
                  onClick={() => setPnlMode("ANNUALIZED")}
                  className={`transition-all ${
                    pnlMode === "ANNUALIZED"
                      ? "text-[color:var(--terminal-cyan)]"
                      : "text-[color:var(--terminal-cyan-dim)] hover:text-[color:var(--terminal-cyan)]"
                  }`}
                >
                  [ANNUALIZED]
                </button>
                <span className="text-[color:var(--terminal-cyan-dim)]">/</span>
                <button
                  onClick={() => setPnlMode("30D")}
                  className={`transition-all ${
                    pnlMode === "30D"
                      ? "text-[color:var(--terminal-cyan)]"
                      : "text-[color:var(--terminal-cyan-dim)] hover:text-[color:var(--terminal-cyan)]"
                  }`}
                >
                  [30D_PERFORMANCE]
                </button>
              </div>
            ) : (
              <span className="text-[10px] text-[color:var(--terminal-cyan-dim)] block truncate">
                {metric.label}
              </span>
            )}
            <div className="flex items-baseline gap-2 mt-1">
              {loading && !metric.value ? (
                <TerminalSkeletonLine className="w-16 h-4" />
              ) : (
              <span className="text-sm font-semibold text-primary">
                {metric.value ?? "--"}
              </span>
              )}
              {metric.change && (
                <span className={`text-xs ${formatSignedClass(metric.changeValue)}`}>
                  {metric.change}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
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
  return `${value.toFixed(2)}%`
}

function formatPercentSigned(value?: number | null) {
  if (value === undefined || value === null) return "--"
  const prefix = value >= 0 ? "+" : "-"
  return `${prefix}${Math.abs(value).toFixed(2)}%`
}

function formatSignedClass(value?: number | null) {
  if (value === undefined || value === null) return "text-muted-foreground"
  return value >= 0 ? "text-[color:var(--terminal-green)] font-medium" : "text-destructive font-medium"
}
