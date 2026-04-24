"use client"

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { BlinkingLabel } from "./blinking-label"
import { TerminalSkeletonLine } from "./terminal-skeleton"

type PositionEntry = {
  vaultAddress: string
  vaultName?: string
  sizePct: number | null
  amountUsd: number | null
  pnlUsd: number | null
  roePct: number | null
}

type PositionsResponse = {
  userAddress: string
  totalPositions: number
  totalCapitalUsd: number | null
  totalInvestedUsd: number | null
  netPnlUsd: number | null
  positions: PositionEntry[]
}

type HistoryEntry = {
  time: number
  type: "vaultDeposit" | "vaultWithdraw"
  vaultAddress: string
  vaultName?: string
  amountUsd: number | null
  realizedPnlUsd: number | null
}

type HistoryResponse = {
  userAddress: string
  total: number
  page: number
  pageSize: number
  totalPages: number
  entries: HistoryEntry[]
}

const API_BASE = process.env.NEXT_PUBLIC_VAULT_API_BASE_URL ?? "http://localhost:3000"

function TerminalLoader({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-4">
      <div className="terminal-loader-bar" />
      <span className="text-xs text-muted-foreground">{text}</span>
    </div>
  )
}

function roeColorClass(roe: number | null): string {
  if (roe === null) return "text-muted-foreground"
  if (roe <= -5) return "roe-deep-red"
  if (roe < 0) return "roe-red"
  if (roe === 0) return "roe-neutral"
  if (roe < 10) return "roe-green"
  return "roe-bright-green"
}

export function PositionsTable() {
  const [activeTab, setActiveTab] = useState<"positions" | "history">("positions")
  const [historyPage, setHistoryPage] = useState(1)
  const [sortConfig, setSortConfig] = useState<{
    key: "asset" | "size" | "amount" | "pnl" | "roe"
    direction: "asc" | "desc"
  }>({ key: "size", direction: "desc" })

  const tabs = [
    { id: "positions" as const, label: "POSITIONS" },
    { id: "history" as const, label: "HISTORY" },
  ]

  const { data: positionsData, isLoading: loadingPositions } = useQuery<PositionsResponse>({
    queryKey: ["positions"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/positions`)
      if (!res.ok) throw new Error("API error")
      return res.json()
    },
  })

  const { data: historyData, isLoading: loadingHistory } = useQuery<HistoryResponse>({
    queryKey: ["history", historyPage],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/history?page=${historyPage}&pageSize=15`)
      if (!res.ok) throw new Error("API error")
      return res.json()
    },
    placeholderData: (prev) => prev,
  })

  const positions = positionsData?.positions ?? []
  const history = historyData?.entries ?? []
  const netPnl = positionsData?.netPnlUsd ?? null
  const totalPositions = positionsData?.totalPositions ?? 0
  const totalHistoryPages = historyData?.totalPages ?? 1
  const maxSizePct = Math.max(
    ...positions.map((p) => p.sizePct ?? 0),
    1,
  )

  const sortedPositions = [...positions].sort((a, b) => {
    const direction = sortConfig.direction === "asc" ? 1 : -1
    const compareNullable = (left: number | string | null, right: number | string | null) => {
      if (left === null && right === null) return 0
      if (left === null) return 1
      if (right === null) return -1
      if (typeof left === "string" && typeof right === "string") return left.localeCompare(right)
      if (left > right) return 1
      if (left < right) return -1
      return 0
    }

    switch (sortConfig.key) {
      case "asset":
        return direction * compareNullable(a.vaultName ?? a.vaultAddress, b.vaultName ?? b.vaultAddress)
      case "size":
        return direction * compareNullable(a.sizePct, b.sizePct)
      case "amount":
        return direction * compareNullable(a.amountUsd, b.amountUsd)
      case "pnl":
        return direction * compareNullable(a.pnlUsd, b.pnlUsd)
      case "roe":
        return direction * compareNullable(a.roePct, b.roePct)
      default:
        return 0
    }
  })

  const toggleSort = (key: "asset" | "size" | "amount" | "pnl" | "roe") => {
    setSortConfig((prev) => {
      if (prev.key === key) {
        return { key, direction: prev.direction === "asc" ? "desc" : "asc" }
      }
      const defaultDirection = key === "asset" ? "asc" : "desc"
      return { key, direction: defaultDirection }
    })
  }

  const sortIndicator = (key: "asset" | "size" | "amount" | "pnl" | "roe") => {
    if (sortConfig.key !== key) return ""
    return sortConfig.direction === "asc" ? " ^" : " v"
  }

  return (
    <div className="terminal-border p-3">
      <div className="flex items-center justify-between mb-3">
        <BlinkingLabel text="TRADE_DATA" prefix="::" as="h2" />
        <div className="flex gap-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-2 py-1 text-xs transition-all ${
                activeTab === tab.id
                  ? "terminal-button bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-primary"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        {activeTab === "positions" && (
          <table className="w-full text-xs terminal-tab-content">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="text-left py-2 pr-2 cursor-pointer select-none" onClick={() => toggleSort("asset")}>
                  VAULT{sortIndicator("asset")}
                </th>
                <th className="text-right py-2 px-2 cursor-pointer select-none" onClick={() => toggleSort("size")}>
                  SIZE{sortIndicator("size")}
                </th>
                <th className="text-right py-2 px-2 hidden sm:table-cell cursor-pointer select-none" onClick={() => toggleSort("amount")}>
                  AMOUNT{sortIndicator("amount")}
                </th>
                <th className="text-right py-2 px-2 cursor-pointer select-none" onClick={() => toggleSort("pnl")}>
                  PNL{sortIndicator("pnl")}
                </th>
                <th className="text-right py-2 pl-2 cursor-pointer select-none" onClick={() => toggleSort("roe")}>
                  ROE{sortIndicator("roe")}
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedPositions.map((pos, i) => {
                const barWidth = pos.sizePct != null ? (pos.sizePct / maxSizePct) * 100 : 0
                return (
                  <tr key={i} className="border-b border-border/30 hover:bg-secondary/30 transition-colors">
                    <td className="py-2 pr-2 font-semibold text-primary">
                      <a
                        href={`https://app.hyperliquid.xyz/vaults/${pos.vaultAddress}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline hover:text-[color:var(--terminal-cyan)] transition-colors"
                      >
                        {pos.vaultName ?? formatAddress(pos.vaultAddress)}
                      </a>
                    </td>
                    <td className="py-2 px-2 text-right text-primary position-bar-cell">
                      <div className="position-bar" style={{ width: `${barWidth}%` }} />
                      <span className="relative z-10">{formatPercent(pos.sizePct)}</span>
                    </td>
                    <td className="py-2 px-2 text-right hidden sm:table-cell">{formatUsd(pos.amountUsd)}</td>
                    <td className={`py-2 px-2 text-right ${formatSignedClass(pos.pnlUsd)}`}>
                      {formatUsdSigned(pos.pnlUsd)}
                    </td>
                    <td className={`py-2 pl-2 text-right ${roeColorClass(pos.roePct)}`}>
                      {formatPercentSigned(pos.roePct)}
                    </td>
                  </tr>
                )
              })}
              {!positions.length && loadingPositions && (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={`skel-${i}`} className="border-b border-border/30">
                    <td className="py-2 pr-2"><TerminalSkeletonLine className="w-24 h-3" /></td>
                    <td className="py-2 px-2"><TerminalSkeletonLine className="w-12 h-3 ml-auto" /></td>
                    <td className="py-2 px-2 hidden sm:table-cell"><TerminalSkeletonLine className="w-14 h-3 ml-auto" /></td>
                    <td className="py-2 px-2"><TerminalSkeletonLine className="w-14 h-3 ml-auto" /></td>
                    <td className="py-2 pl-2"><TerminalSkeletonLine className="w-12 h-3 ml-auto" /></td>
                  </tr>
                ))
              )}
              {!positions.length && !loadingPositions && (
                <tr className="border-b border-border/30">
                  <td className="py-3 text-center text-muted-foreground" colSpan={5}>
                    NO_POSITIONS
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
        {activeTab === "history" && (
          <table className="w-full text-xs terminal-tab-content">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="text-left py-2 pr-2">TIME</th>
                <th className="text-left py-2 px-2">TYPE</th>
                <th className="text-left py-2 px-2">VAULT</th>
                <th className="text-right py-2 px-2">AMOUNT</th>
                <th className="text-right py-2 pl-2">REALIZED</th>
              </tr>
            </thead>
            <tbody>
              {history.map((entry, i) => (
                <tr key={`${entry.vaultAddress}-${entry.time}-${i}`} className="border-b border-border/30">
                  <td className="py-2 pr-2 text-muted-foreground">{formatDate(entry.time)}</td>
                  <td className={`py-2 px-2 ${entry.type === "vaultDeposit" ? "text-primary" : "text-[color:var(--terminal-cyan)]"}`}>
                    {entry.type === "vaultDeposit" ? "DEPOSIT" : "WITHDRAW"}
                  </td>
                  <td className="py-2 px-2 text-primary">
                    {entry.vaultName ?? formatAddress(entry.vaultAddress)}
                  </td>
                  <td className="py-2 px-2 text-right">{formatUsd(entry.amountUsd)}</td>
                  <td className={`py-2 pl-2 text-right ${formatRealizedClass(entry.realizedPnlUsd)}`}>
                    {formatUsdSigned(entry.realizedPnlUsd)}
                  </td>
                </tr>
              ))}
              {!history.length && loadingHistory && (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={`skel-h-${i}`} className="border-b border-border/30">
                    <td className="py-2 pr-2"><TerminalSkeletonLine className="w-16 h-3" /></td>
                    <td className="py-2 px-2"><TerminalSkeletonLine className="w-16 h-3" /></td>
                    <td className="py-2 px-2"><TerminalSkeletonLine className="w-24 h-3" /></td>
                    <td className="py-2 px-2"><TerminalSkeletonLine className="w-14 h-3 ml-auto" /></td>
                    <td className="py-2 pl-2"><TerminalSkeletonLine className="w-14 h-3 ml-auto" /></td>
                  </tr>
                ))
              )}
              {!history.length && !loadingHistory && (
                <tr className="border-b border-border/30">
                  <td className="py-3 text-center text-muted-foreground" colSpan={5}>
                    NO_HISTORY
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {activeTab === "history" && (
        <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>
            PAGE {historyPage} / {totalHistoryPages}
          </span>
          <div className="flex gap-2">
            <button
              className="terminal-button px-2 py-1 text-xs"
              disabled={historyPage <= 1}
              onClick={() => setHistoryPage((prev) => Math.max(1, prev - 1))}
            >
              PREV
            </button>
            <button
              className="terminal-button px-2 py-1 text-xs"
              disabled={historyPage >= totalHistoryPages}
              onClick={() => setHistoryPage((prev) => Math.min(totalHistoryPages, prev + 1))}
            >
              NEXT
            </button>
          </div>
        </div>
      )}

      <div className="mt-3 pt-2 border-t border-border/50 text-xs text-muted-foreground flex justify-between">
        <span>TOTAL_POSITIONS: {totalPositions}</span>
        <span className={formatSignedClass(netPnl)}>NET_PNL: {formatUsdSigned(netPnl)}</span>
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
  const prefix = value >= 0 ? "+" : ""
  return `${prefix}$${Math.abs(value).toFixed(2)}`
}

function formatPercent(value?: number | null) {
  if (value === undefined || value === null) return "--"
  return `${value.toFixed(2)}%`
}

function formatPercentSigned(value?: number | null) {
  if (value === undefined || value === null) return "--"
  const prefix = value >= 0 ? "+" : ""
  return `${prefix}${Math.abs(value).toFixed(2)}%`
}

function formatSignedClass(value?: number | string | null) {
  const numeric = parseSignedNumber(value)
  if (numeric === null) return "text-muted-foreground"
  return numeric >= 0 ? "text-[color:var(--terminal-green-bright)]" : "text-destructive"
}

function formatRealizedClass(value?: number | string | null) {
  const numeric = parseSignedNumber(value)
  if (numeric === null) return "text-muted-foreground"
  return numeric > 0
    ? "text-[color:var(--terminal-green-bright)]"
    : numeric < 0
      ? "text-destructive"
      : "text-muted-foreground"
}

function formatAddress(address: string) {
  if (!address) return "0x"
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function formatDate(ms: number) {
  if (!Number.isFinite(ms)) return "--"
  const date = new Date(ms)
  return date.toISOString().slice(0, 10)
}

function parseSignedNumber(value?: number | string | null): number | null {
  if (value === undefined || value === null) return null
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  const cleaned = value.replace(/[^0-9.+-]/g, "")
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}
