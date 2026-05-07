"use client"

import { useState } from "react"
import { BlinkingLabel } from "./blinking-label"
import { TerminalSkeletonLine } from "./terminal-skeleton"
import { useFundState } from "@/hooks/useVault4Fund"
import {
  useRecentActivity,
  entryToUsd,
  type ActivityEntry,
  type ActivityType,
} from "@/hooks/useRecentActivity"

const PAGE_SIZE = 10

const TYPE_LABEL: Record<ActivityType, string> = {
  DEPOSIT: "DEPOSIT",
  WITHDRAW: "WITHDRAW",
  INSTANT_WITHDRAW: "INSTANT_W",
  DEPOSIT_CANCELLED: "DEP_CANCEL",
  WITHDRAW_CANCELLED: "WD_CANCEL",
}

const TYPE_COLOR: Record<ActivityType, string> = {
  DEPOSIT: "text-[color:var(--terminal-green)]",
  WITHDRAW: "text-[color:var(--terminal-cyan)]",
  INSTANT_WITHDRAW: "text-[color:var(--terminal-cyan)]",
  DEPOSIT_CANCELLED: "text-[color:var(--terminal-amber-dim)]",
  WITHDRAW_CANCELLED: "text-[color:var(--terminal-amber-dim)]",
}

const TYPE_SIGN: Record<ActivityType, string> = {
  DEPOSIT: "+",
  WITHDRAW: "−",
  INSTANT_WITHDRAW: "−",
  DEPOSIT_CANCELLED: "✕",
  WITHDRAW_CANCELLED: "✕",
}

export function RecentActivity() {
  const fund = useFundState()
  const [page, setPage] = useState(1)
  const { data, isLoading, error } = useRecentActivity(page, PAGE_SIZE)

  if (!fund.configured) return null

  const entries = data?.entries ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const scannedPct = data?.scannedPct ?? 0

  return (
    <div className="terminal-border p-3 sm:p-4">
      <div className="flex items-center justify-between gap-2">
        <BlinkingLabel text="RECENT_ACTIVITY" prefix="::" as="h2" />
        <span className="text-xs text-muted-foreground">
          {isLoading && !data
            ? "scanning..."
            : `${total} events · 90d window${scannedPct < 95 ? ` (${scannedPct}% indexed)` : ""}`}
        </span>
      </div>

      {error && (
        <div className="mt-3 text-xs text-destructive">
          ! Failed to load activity: {(error as Error).message?.slice(0, 80)}
        </div>
      )}

      {isLoading && !data && (
        <div className="mt-3 space-y-1.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <TerminalSkeletonLine key={i} className="h-5 w-full" />
          ))}
        </div>
      )}

      {!isLoading && entries.length === 0 && !error && (
        <div className="mt-3 text-xs text-muted-foreground">
          No deposits or withdrawals in the last 90 days.
        </div>
      )}

      {entries.length > 0 && (
        <>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="text-[color:var(--terminal-green-dim)] text-left">
                  <th className="py-1.5 pr-2 font-normal">TYPE</th>
                  <th className="py-1.5 pr-2 font-normal">WALLET</th>
                  <th className="py-1.5 pr-2 font-normal text-right">USDC</th>
                  <th className="py-1.5 pr-2 font-normal text-right hidden sm:table-cell">TIME</th>
                  <th className="py-1.5 font-normal text-right">TX</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <ActivityRow
                    key={`${e.txHash}-${e.type}-${e.investor}`}
                    entry={e}
                    sharePrice={fund.sharePrice}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="mt-3 flex items-center justify-between text-xs">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="text-[color:var(--terminal-cyan-dim)] hover:text-[color:var(--terminal-cyan)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                [‹ PREV]
              </button>
              <span className="text-muted-foreground">
                PAGE {page} / {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="text-[color:var(--terminal-cyan-dim)] hover:text-[color:var(--terminal-cyan)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                [NEXT ›]
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ActivityRow({ entry, sharePrice }: { entry: ActivityEntry; sharePrice: number }) {
  const { usdc, isApprox } = entryToUsd(entry, sharePrice)
  const colorCls = TYPE_COLOR[entry.type]
  return (
    <tr className="border-t border-border/40">
      <td className={`py-1.5 pr-2 ${colorCls} font-semibold`}>{TYPE_LABEL[entry.type]}</td>
      <td className="py-1.5 pr-2 text-[color:var(--terminal-green-dim)]">
        {shortAddr(entry.investor)}
      </td>
      <td className={`py-1.5 pr-2 text-right ${colorCls}`}>
        {TYPE_SIGN[entry.type]}
        {isApprox ? "≈" : ""}${usdc.toFixed(2)}
      </td>
      <td className="py-1.5 pr-2 text-right text-muted-foreground hidden sm:table-cell">
        {formatTimeAgo(entry.timestamp)}
      </td>
      <td className="py-1.5 text-right">
        <a
          href={`https://hypurrscan.io/evm/tx/${entry.txHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[color:var(--terminal-cyan-dim)] hover:text-[color:var(--terminal-cyan)] transition-colors"
        >
          ↗
        </a>
      </td>
    </tr>
  )
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function formatTimeAgo(unixSec: number) {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - unixSec)
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  const days = Math.floor(diff / 86400)
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}
