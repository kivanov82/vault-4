"use client"

import { useEffect, useState } from "react"
import { useAccount } from "wagmi"
import { TerminalHeader } from "./terminal-header"
import { AccountStats } from "./account-stats"
import { PnlChart } from "./pnl-chart"
import { PositionsTable } from "./positions-table"
import { ActionButtons } from "./action-buttons"
import { PerformanceMetrics } from "./performance-metrics"
import { CyclingTextPanel } from "./cycling-text-panel"
import { MatrixRain } from "./matrix-rain"
import { CornerDecorations } from "./corner-decorations"

export function TerminalPortfolio() {
  const { isConnected } = useAccount()
  const [lastRefresh, setLastRefresh] = useState("")

  useEffect(() => {
    const update = () => setLastRefresh(new Date().toISOString().slice(11, 19))
    update()
    const interval = setInterval(update, 30_000)
    return () => clearInterval(interval)
  }, [])

  return (
    <>
      <MatrixRain />
      <CornerDecorations />

      <main className="min-h-screen bg-background p-3 md:p-4 md:pb-10 max-w-2xl mx-auto relative z-10">
        <div className="boot-section boot-delay-0">
          <TerminalHeader />
        </div>

        <div className="space-y-3 mt-4">
          {isConnected && (
            <div className="boot-section boot-delay-1">
              <AccountStats />
            </div>
          )}
          {isConnected && (
            <div className="boot-section boot-delay-2">
              <ActionButtons />
            </div>
          )}
          <div className="boot-section boot-delay-3">
            <PerformanceMetrics />
          </div>
          <div className="boot-section boot-delay-4">
            <PnlChart />
          </div>
          <div className="boot-section boot-delay-5">
            <PositionsTable />
          </div>
          <div className="boot-section boot-delay-6">
            <CyclingTextPanel />
          </div>
        </div>

        <div className="boot-section boot-delay-7">
          <footer className="mt-4 status-bar">
            <div className="flex items-center justify-between text-[10px] font-mono">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <span className="status-indicator status-indicator-active" />
                  <span className="text-[color:var(--terminal-green)]">FEED ACTIVE</span>
                </div>
                <span className="text-[color:var(--terminal-green-dim)]">|</span>
                <span className="text-[color:var(--terminal-green-dim)]">LAST_SYNC: {lastRefresh}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-[color:var(--terminal-green-dim)]">SYSTEM NOMINAL</span>
                <span className="text-[color:var(--terminal-green-dim)]">|</span>
                <span className="glow-text text-[color:var(--terminal-green)]">v1.0.0_MAINNET</span>
              </div>
            </div>
          </footer>
        </div>
      </main>
    </>
  )
}
