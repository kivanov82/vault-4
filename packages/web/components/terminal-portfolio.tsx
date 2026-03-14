"use client"

import { useEffect, useState } from "react"
import { useAccount } from "wagmi"
import { TerminalHeader } from "./terminal-header"
import { AccountStats } from "./account-stats"
import { PnlChart } from "./pnl-chart"
import { PositionsTable } from "./positions-table"
import { PerformanceMetrics } from "./performance-metrics"
import { InvestPanel } from "./invest-panel"
import { QueueStatus } from "./queue-status"
import { CyclingTextPanel } from "./cycling-text-panel"
import { MatrixRain } from "./matrix-rain"
import { CornerDecorations } from "./corner-decorations"

type Tab = "DASHBOARD" | "INVEST"

export function TerminalPortfolio() {
  const { isConnected } = useAccount()
  const [activeTab, setActiveTab] = useState<Tab>("DASHBOARD")
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

        {/* Tab navigation */}
        <div className="boot-section boot-delay-1 mt-4">
          <div className="flex gap-1 terminal-border p-1">
            {(["DASHBOARD", "INVEST"] as Tab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`flex-1 py-2 text-xs font-semibold tracking-wider transition-all ${
                  activeTab === tab
                    ? "terminal-button bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-primary"
                }`}
              >
                [{tab}]
              </button>
            ))}
          </div>
        </div>

        {/* Tab content */}
        <div className="space-y-3 mt-3">
          {activeTab === "DASHBOARD" && (
            <div className="space-y-3 terminal-tab-content">
              <div className="boot-section boot-delay-2">
                <PerformanceMetrics />
              </div>
              <div className="boot-section boot-delay-3">
                <PnlChart />
              </div>
              <div className="boot-section boot-delay-4">
                <PositionsTable />
              </div>
            </div>
          )}

          {activeTab === "INVEST" && (
            <div className="space-y-3 terminal-tab-content">
              {isConnected && (
                <div className="boot-section boot-delay-3">
                  <AccountStats />
                </div>
              )}
              <div className="boot-section boot-delay-4">
                <InvestPanel />
              </div>
              <div className="boot-section boot-delay-5">
                <QueueStatus />
              </div>
            </div>
          )}

          {/* Shared footer: disclaimers */}
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
