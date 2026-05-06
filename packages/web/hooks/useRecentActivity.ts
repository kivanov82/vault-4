"use client"

import { useQuery } from "@tanstack/react-query"

const API_BASE = process.env.NEXT_PUBLIC_VAULT_API_BASE_URL ?? ""

export type ActivityType =
  | "DEPOSIT"
  | "WITHDRAW"
  | "INSTANT_WITHDRAW"
  | "DEPOSIT_CANCELLED"
  | "WITHDRAW_CANCELLED"

export interface ActivityEntry {
  type: ActivityType
  investor: `0x${string}`
  /** USDC amount, when emitted directly (deposits, deposit cancels, instant withdraw). */
  assets?: number
  /** Share count, when emitted directly (withdraws, withdraw cancels, instant withdraw). */
  shares?: number
  txHash: `0x${string}`
  blockNumber: number
  /** Unix seconds. */
  timestamp: number
}

export interface ActivityPage {
  entries: ActivityEntry[]
  total: number
  page: number
  pageSize: number
  indexedThroughBlock: number
  scannedPct: number
}

/**
 * Fetch a paginated page of vault activity (all wallets, ~90 days back) from
 * the backend. The backend handles RPC chunking, rate-limiting and caching.
 */
export function useRecentActivity(page: number, pageSize: number) {
  return useQuery<ActivityPage>({
    queryKey: ["recent-activity", page, pageSize],
    refetchInterval: 30_000,
    staleTime: 15_000,
    queryFn: async () => {
      const url = `${API_BASE}/api/activity?page=${page}&pageSize=${pageSize}`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`activity fetch failed: ${res.status}`)
      return res.json()
    },
  })
}

/**
 * Convert any activity entry to a USDC amount for display.
 *  - Events with `assets` use it directly.
 *  - Events with only `shares` are multiplied by current sharePrice.
 *
 * Returns `{ usdc, isApprox }` — the UI uses `isApprox` to render a `≈` prefix.
 */
export function entryToUsd(entry: ActivityEntry, sharePrice: number) {
  if (entry.assets !== undefined) {
    return { usdc: entry.assets, isApprox: false }
  }
  if (entry.shares !== undefined) {
    return { usdc: entry.shares * sharePrice, isApprox: true }
  }
  return { usdc: 0, isApprox: false }
}
