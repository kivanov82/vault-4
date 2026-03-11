"use client"

import { useEffect, useState } from "react"

interface TickerData {
  hypePrice: number
  volume24h: number
  openInterest: number
  fundingRate: number
}

type HyperliquidMeta = {
  universe: { name: string }[]
}

type HyperliquidAssetCtx = {
  funding?: string
  openInterest?: string
  dayNtlVlm?: string
  markPx?: string
  midPx?: string
  oraclePx?: string
}

const INFO_ENDPOINT = "https://api.hyperliquid.xyz/info"
const HYPE_SYMBOL = "HYPE"

export function LiveDataTicker() {
  const [data, setData] = useState<TickerData | null>(null)
  const [flash, setFlash] = useState<string | null>(null)

  useEffect(() => {
    let active = true

    const load = async () => {
      const next = await fetchHyperliquidTicker()
      if (!next || !active) return
      setData((prev) => {
        if (prev) {
          const changes = [
            { key: "hype", diff: ratioDiff(next.hypePrice, prev.hypePrice) },
            { key: "vol", diff: ratioDiff(next.volume24h, prev.volume24h) },
            { key: "oi", diff: ratioDiff(next.openInterest, prev.openInterest) },
            { key: "fr", diff: ratioDiff(next.fundingRate, prev.fundingRate) },
          ]
          const maxChange = changes.reduce((a, b) => (a.diff > b.diff ? a : b))
          setFlash(maxChange.key)
          setTimeout(() => setFlash(null), 300)
        }
        return next
      })
    }

    load()
    const interval = setInterval(load, 3000)

    return () => {
      active = false
      clearInterval(interval)
    }
  }, [])

  return (
    <div className="flex items-center gap-3 text-[10px] overflow-x-auto scrollbar-hide">
      <div className={`flex items-center gap-1 transition-all ${flash === "hype" ? "data-flash" : ""}`}>
        <span className="text-[color:var(--terminal-cyan-dim)]">$HYPE:</span>
        <span className="text-[color:var(--terminal-cyan)] glow-text-cyan">{formatPrice(data?.hypePrice)}</span>
      </div>
      <span className="text-[color:var(--terminal-cyan-dim)]">|</span>
      <div className={`flex items-center gap-1 transition-all ${flash === "vol" ? "data-flash" : ""}`}>
        <span className="text-[color:var(--terminal-cyan-dim)]">VOL_24H:</span>
        <span className="text-[color:var(--terminal-cyan)]">{formatVolume(data?.volume24h)}</span>
      </div>
      <span className="text-[color:var(--terminal-cyan-dim)]">|</span>
      <div className={`flex items-center gap-1 transition-all ${flash === "oi" ? "data-flash" : ""}`}>
        <span className="text-[color:var(--terminal-cyan-dim)]">OI:</span>
        <span className="text-[color:var(--terminal-cyan)]">{formatOpenInterest(data?.openInterest)}</span>
      </div>
      <span className="text-[color:var(--terminal-cyan-dim)]">|</span>
      <div className={`flex items-center gap-1 transition-all ${flash === "fr" ? "data-flash" : ""}`}>
        <span className="text-[color:var(--terminal-cyan-dim)]">FR:</span>
        <span className={data && data.fundingRate < 0 ? "text-destructive" : "text-[color:var(--terminal-cyan)]"}>
          {formatFundingRate(data?.fundingRate)}
        </span>
      </div>
    </div>
  )
}

async function fetchHyperliquidTicker(): Promise<TickerData | null> {
  try {
    const response = await fetch(INFO_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" }),
    })
    if (!response.ok) return null
    const payload = (await response.json()) as [HyperliquidMeta, HyperliquidAssetCtx[]]
    const meta = payload?.[0]
    const ctxs = payload?.[1]
    if (!meta?.universe || !Array.isArray(ctxs)) return null
    const index = meta.universe.findIndex((asset) => asset.name === HYPE_SYMBOL)
    if (index === -1 || !ctxs[index]) return null
    const ctx = ctxs[index]
    const price = parseNumber(ctx.markPx ?? ctx.midPx ?? ctx.oraclePx)
    const volume = parseNumber(ctx.dayNtlVlm)
    const openInterest = parseNumber(ctx.openInterest) * (price || 0)
    const fundingRate = parseNumber(ctx.funding)
    return {
      hypePrice: price,
      volume24h: volume,
      openInterest,
      fundingRate,
    }
  } catch {
    return null
  }
}

function parseNumber(value?: string): number {
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

function ratioDiff(next: number, prev: number): number {
  if (!Number.isFinite(prev) || prev === 0) return Math.abs(next)
  return Math.abs(next - prev) / Math.abs(prev)
}

function formatPrice(value?: number) {
  if (!value) return "--"
  return `$${value.toFixed(2)}`
}

function formatVolume(value?: number) {
  if (!value) return "--"
  return `$${(value / 1_000_000).toFixed(1)}M`
}

function formatOpenInterest(value?: number) {
  if (!value) return "--"
  return `$${(value / 1_000_000_000).toFixed(2)}B`
}

function formatFundingRate(value?: number) {
  if (value === undefined || value === null) return "--"
  const percent = value * 100
  return `${percent >= 0 ? "+" : ""}${percent.toFixed(4)}%`
}
