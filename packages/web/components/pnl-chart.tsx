"use client"

import { useMemo, useState, useEffect, useRef } from "react"
import { Area, AreaChart, ResponsiveContainer, XAxis, YAxis, Tooltip } from "recharts"
import { BlinkingLabel } from "./blinking-label"
import { LiveDataTicker } from "./live-data-ticker"
import { TerminalSkeletonBlock } from "./terminal-skeleton"
import { ConnectionError } from "./connection-error"
import { LAUNCH_DATE_MS } from "@/lib/constants"

type SeriesPoint = { timestamp: number; value: number }

type PortfolioHistory = {
  pnl: { points: SeriesPoint[] } | null
  accountValue: { points: SeriesPoint[] } | null
}

type PortfolioResponse = {
  userAddress: string
  history: PortfolioHistory
}

type ChartPoint = {
  timestamp: number
  value: number | null
  label: string
}

const API_BASE = process.env.NEXT_PUBLIC_VAULT_API_BASE_URL ?? "http://localhost:3000"

function AnimatedDot(props: { cx?: number; cy?: number; stroke?: string }) {
  const { cx, cy, stroke } = props
  if (!cx || !cy) return null

  return (
    <g>
      <circle cx={cx} cy={cy} r={6} fill={stroke} opacity={0.2} className="oscilloscope-pulse" />
      <circle cx={cx} cy={cy} r={4} fill={stroke} opacity={0.4} className="oscilloscope-pulse-delay" />
      <circle cx={cx} cy={cy} r={2} fill={stroke} />
    </g>
  )
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)")
    setIsMobile(mq.matches)
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener("change", handler)
    return () => mq.removeEventListener("change", handler)
  }, [])
  return isMobile
}

export function PnlChart() {
  const [chartMode, setChartMode] = useState<"PNL" | "ACC_VALUE">("PNL")
  const [timePeriod, setTimePeriod] = useState<"1M" | "7D" | "30D" | "ALL">("30D")
  const [animationKey, setAnimationKey] = useState(0)
  const [portfolio, setPortfolio] = useState<PortfolioResponse | null>(null)
  const [chartError, setChartError] = useState(false)
  const [retryKey, setRetryKey] = useState(0)
  const isMobile = useIsMobile()
  const [liveSeries, setLiveSeries] = useState<{ pnl: (number | null)[]; acc: (number | null)[] }>({
    pnl: [],
    acc: [],
  })
  const liveCursorRef = useRef(0)

  useEffect(() => {
    let active = true
    const load = async () => {
      setChartError(false)
      try {
        const response = await fetch(`${API_BASE}/api/portfolio`)
        if (!response.ok) throw new Error("API error")
        const payload = (await response.json()) as PortfolioResponse
        if (active) setPortfolio(payload)
      } catch {
        if (active) setChartError(true)
      }
    }
    load()
    return () => { active = false }
  }, [retryKey])

  useEffect(() => {
    if (timePeriod !== "1M") return
    let active = true
    liveCursorRef.current = 0
    setLiveSeries({ pnl: Array(60).fill(null), acc: Array(60).fill(null) })
    const tick = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/portfolio?refresh=true`)
        if (!response.ok) return
        const payload = (await response.json()) as PortfolioResponse
        if (!active) return
        const pnlValue = latestValue(payload.history?.pnl?.points) ?? 0
        const accValue = latestValue(payload.history?.accountValue?.points) ?? 0
        const index = liveCursorRef.current
        setLiveSeries((prev) => ({
          pnl: writeLivePoint(prev.pnl, index, pnlValue),
          acc: writeLivePoint(prev.acc, index, accValue),
        }))
        liveCursorRef.current = (index + 1) % 60
      } catch {
        // ignore
      }
    }
    tick()
    const interval = setInterval(tick, 1000)
    return () => { active = false; clearInterval(interval) }
  }, [timePeriod, chartMode])

  const data = useMemo(() => {
    if (timePeriod === "1M") {
      const series = chartMode === "PNL" ? liveSeries.pnl : liveSeries.acc
      if (!series.length) return [{ timestamp: Date.now(), value: 0, label: "00" }]
      return series.map((value, index) => ({
        timestamp: Date.now(),
        value,
        label: String(index + 1).padStart(2, "0"),
      }))
    }

    const series =
      chartMode === "PNL"
        ? portfolio?.history?.pnl?.points ?? []
        : portfolio?.history?.accountValue?.points ?? []
    const normalized = normalizeSeries(series)
    if (!normalized.length) return [{ timestamp: Date.now(), value: 0, label: "NA" }]
    const filtered = filterByPeriod(normalized, timePeriod)
    const capped = downsample(filtered, timePeriod === "ALL" ? 120 : 60)
    return capped.map((point) => ({
      timestamp: point.timestamp,
      value: point.value,
      label: formatLabel(point.timestamp, timePeriod),
    }))
  }, [portfolio, chartMode, timePeriod, liveSeries])

  const numericValues = data.map((d) => d.value).filter((value) => Number.isFinite(value))
  const minValue = numericValues.length ? Math.min(...(numericValues as number[])) : 0
  const maxValue = numericValues.length ? Math.max(...(numericValues as number[])) : 0
  const lastLiveValue = timePeriod === "1M" ? findLastValue(data) : null
  const axisDomain = computeAxisDomain(minValue, maxValue, timePeriod, lastLiveValue)

  const strokeColor = chartMode === "PNL" ? "#00ff41" : "#00d4ff"
  const gradientId = chartMode === "PNL" ? "pnlGradient" : "accGradient"

  useEffect(() => {
    setAnimationKey((k) => k + 1)
  }, [chartMode, timePeriod])

  return (
    <div className="terminal-border-hero p-3 chart-container">
      <div className="mb-3 pb-2 border-b border-[color:var(--terminal-cyan-dim)]">
        <LiveDataTicker />
      </div>

      <div className="flex items-center justify-between mb-3 flex-wrap gap-y-2">
        <div className="flex items-center gap-1 text-xs">
          <button
            onClick={() => setChartMode("PNL")}
            className={`px-2 py-1 transition-all ${
              chartMode === "PNL"
                ? "terminal-button bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-primary border border-transparent hover:border-primary/30"
            }`}
          >
            [PNL]
          </button>
          <span className="text-muted-foreground">/</span>
          <button
            onClick={() => setChartMode("ACC_VALUE")}
            className={`px-2 py-1 transition-all ${
              chartMode === "ACC_VALUE"
                ? "terminal-button bg-[#00d4ff] text-primary-foreground"
                : "text-muted-foreground hover:text-[#00d4ff] border border-transparent hover:border-[#00d4ff]/30"
            }`}
          >
            [ACC_VALUE]
          </button>
        </div>
        <div className="flex gap-2 text-xs">
          {(["1M", "7D", "30D", "ALL"] as const).map((period) => (
            <button
              key={period}
              onClick={() => setTimePeriod(period)}
              className={`px-2 py-1 transition-all ${
                timePeriod === period
                  ? "terminal-button bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-primary border border-transparent hover:border-primary/30"
              }`}
            >
              {period}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-2 flex items-center gap-2">
        <BlinkingLabel text={chartMode === "PNL" ? "PNL_CHART" : "ACCOUNT_VALUE_CHART"} prefix="#" />
        <span className="signal-dot" />
        <span className="text-[10px] text-muted-foreground signal-text">LIVE</span>
      </div>

      <div className="h-48 md:h-56 chart-glow">
        {chartError && !portfolio ? (
          <div className="w-full h-full flex items-center justify-center">
            <ConnectionError onRetry={() => setRetryKey((k) => k + 1)} />
          </div>
        ) : !portfolio && timePeriod !== "1M" ? (
          <TerminalSkeletonBlock className="w-full h-full flex items-center justify-center">
            <div className="flex items-center gap-3">
              <div className="terminal-loader-bar" />
              <span className="text-xs text-muted-foreground">LOADING_CHART_DATA</span>
            </div>
          </TerminalSkeletonBlock>
        ) : (
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart key={animationKey} data={data} margin={{ top: 5, right: 5, left: isMobile ? -30 : -20, bottom: 0 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={strokeColor} stopOpacity={0.4} />
                <stop offset="50%" stopColor={strokeColor} stopOpacity={0.1} />
                <stop offset="95%" stopColor={strokeColor} stopOpacity={0} />
              </linearGradient>
              <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="2" result="coloredBlur" />
                <feMerge>
                  <feMergeNode in="coloredBlur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            <XAxis
              dataKey="label"
              tick={{ fill: strokeColor, fontSize: 10 }}
              axisLine={{ stroke: `${strokeColor}40` }}
              tickLine={{ stroke: `${strokeColor}40` }}
              interval="preserveStartEnd"
            />
            <YAxis
              domain={[axisDomain.min, axisDomain.max]}
              width={isMobile ? 52 : 72}
              tick={{ fill: strokeColor, fontSize: isMobile ? 9 : 10 }}
              axisLine={{ stroke: `${strokeColor}40` }}
              tickLine={{ stroke: `${strokeColor}40` }}
              tickFormatter={(val) => formatAxisValue(val, chartMode === "PNL")}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "#0a0a0a",
                border: `1px solid ${strokeColor}`,
                color: strokeColor,
                fontSize: 12,
                fontFamily: "monospace",
                boxShadow: `0 0 15px ${strokeColor}40`,
              }}
              formatter={(value: number) => [formatAxisValue(value, chartMode === "PNL"), chartMode === "PNL" ? "PNL" : "VALUE"]}
              labelFormatter={(label) => (timePeriod === "1M" ? `SEC: ${label}` : `DAY: ${label}`)}
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke={strokeColor}
              strokeWidth={2}
              fill={`url(#${gradientId})`}
              dot={false}
              activeDot={<AnimatedDot stroke={strokeColor} />}
              filter="url(#glow)"
              isAnimationActive={true}
              animationDuration={1500}
              animationEasing="ease-out"
              connectNulls={false}
            />
          </AreaChart>
        </ResponsiveContainer>
        )}
      </div>

      <div className="chart-grid-overlay" />
    </div>
  )
}

function normalizeSeries(points: SeriesPoint[]): SeriesPoint[] {
  if (!Array.isArray(points)) return []
  return points
    .map((point) => ({
      timestamp: Number(point.timestamp),
      value: Number(point.value),
    }))
    .filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.value))
    .sort((a, b) => a.timestamp - b.timestamp)
}

function filterByPeriod(points: SeriesPoint[], period: "1M" | "7D" | "30D" | "ALL") {
  const now = Date.now()
  const windowMs = period === "7D" ? 7 : period === "30D" ? 30 : 3650
  const startTime =
    period === "ALL"
      ? LAUNCH_DATE_MS
      : Math.max(LAUNCH_DATE_MS, now - windowMs * 24 * 60 * 60 * 1000)
  return points.filter((point) => point.timestamp >= startTime)
}

function downsample(points: SeriesPoint[], maxPoints: number) {
  if (points.length <= maxPoints) return points
  const step = Math.ceil(points.length / maxPoints)
  return points.filter((_, index) => index % step === 0)
}

function formatLabel(timestamp: number, period: "1M" | "7D" | "30D" | "ALL") {
  const date = new Date(timestamp)
  if (period === "7D") return date.toISOString().slice(5, 10)
  if (period === "30D") return date.toISOString().slice(5, 10)
  return date.toISOString().slice(0, 10)
}

function latestValue(points?: SeriesPoint[] | null): number | null {
  if (!Array.isArray(points) || !points.length) return null
  const last = points[points.length - 1]
  return Number.isFinite(last?.value) ? Number(last.value) : null
}

function writeLivePoint(points: (number | null)[], index: number, value: number): (number | null)[] {
  const length = 60
  let next = points.length === length ? [...points] : Array(length).fill(null)
  if (index === 0 && next.some((entry) => entry !== null)) {
    next = Array(length).fill(null)
  }
  next[index] = value
  return next
}

function formatAxisValue(value: number, includeSign: boolean) {
  if (!Number.isFinite(value)) return "--"
  const abs = Math.abs(value)
  let decimals = 0
  if (abs < 1) decimals = 4
  else if (abs < 10) decimals = 2
  else if (abs < 100) decimals = 1
  else if (abs >= 1000) decimals = 0
  else decimals = 1
  const formatted = `$${abs.toFixed(decimals)}`
  const sign = value >= 0 ? "+" : "-"
  return includeSign ? `${sign}${formatted}` : formatted
}

function computeAxisDomain(
  min: number,
  max: number,
  period: "1M" | "7D" | "30D" | "ALL",
  lastValue: number | null,
): { min: number; max: number } {
  if (period === "1M" && Number.isFinite(lastValue)) {
    const base = Math.abs(lastValue as number)
    const buffer = Math.max(base * 0.00000005, base === 0 ? 0.0000005 : 0)
    return { min: (lastValue as number) - buffer, max: (lastValue as number) + buffer }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: -1, max: 1 }
  if (min === max) {
    const buffer = Math.max(1, Math.abs(min) * 0.02)
    return { min: min - buffer, max: max + buffer }
  }
  const range = Math.max(1, Math.abs(max - min))
  const buffer = range * 0.1
  return { min: min - buffer, max: max + buffer }
}

function findLastValue(points: ChartPoint[]): number | null {
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const value = points[i]?.value
    if (Number.isFinite(value)) return Number(value)
  }
  return null
}
