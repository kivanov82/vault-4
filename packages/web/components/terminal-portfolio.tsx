"use client"

import { useEffect, useState } from "react"
import { useAccount, useConnect } from "wagmi"
import { hyperliquidChain } from "@/lib/wagmi"
import { TerminalHeader } from "./terminal-header"
import { FundOverview } from "./fund-overview"
import { PnlChart } from "./pnl-chart"
import { PositionsTable } from "./positions-table"
import { PerformanceMetrics } from "./performance-metrics"
import { InvestPanel } from "./invest-panel"
import { QueueStatus } from "./queue-status"
import { CyclingTextPanel } from "./cycling-text-panel"
import { MatrixRain } from "./matrix-rain"
import { AmbientGlow } from "./ambient-glow"
import { CornerDecorations } from "./corner-decorations"

type Tab = "DASHBOARD" | "INVEST"

export function TerminalPortfolio() {
  const { isConnected } = useAccount()
  const { connect, connectors } = useConnect()
  const [activeTab, setActiveTab] = useState<Tab>("DASHBOARD")
  const [lastRefresh, setLastRefresh] = useState("")

  useEffect(() => {
    const update = () => setLastRefresh(new Date().toLocaleTimeString([], { hour12: false }))
    update()
    const interval = setInterval(update, 30_000)
    return () => clearInterval(interval)
  }, [])

  const handleTabClick = (tab: Tab) => {
    setActiveTab(tab)
    if (tab === "INVEST" && !isConnected) {
      const connector = connectors[0]
      if (connector) connect({ connector, chainId: hyperliquidChain.id })
    }
  }

  return (
    <>
      <AmbientGlow />
      <MatrixRain />
      <CornerDecorations />

      <main className="min-h-screen bg-background p-3 md:p-4 md:pb-10 max-w-2xl mx-auto relative z-10">
        <div className="boot-section boot-delay-0">
          <TerminalHeader />
        </div>

        {/* Tab navigation */}
        <nav aria-label="Main navigation" className="boot-section boot-delay-1 mt-4">
          <div className="flex gap-1 terminal-border p-1" role="tablist">
            {(["DASHBOARD", "INVEST"] as Tab[]).map((tab) => (
              <button
                key={tab}
                role="tab"
                aria-selected={activeTab === tab}
                onClick={() => handleTabClick(tab)}
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
        </nav>

        {/* Tab content */}
        <div className="space-y-3 mt-3">
          {activeTab === "DASHBOARD" && (
            <div className="space-y-3 terminal-tab-content" role="tabpanel" aria-label="Dashboard">
              <section className="boot-section boot-delay-2" aria-label="Performance metrics">
                <PerformanceMetrics />
              </section>
              <section className="boot-section boot-delay-3" aria-label="PnL chart">
                <PnlChart />
              </section>
              <section className="boot-section boot-delay-4" aria-label="Vault positions">
                <PositionsTable />
              </section>
            </div>
          )}

          {activeTab === "INVEST" && (
            <div className="space-y-3 terminal-tab-content" role="tabpanel" aria-label="Invest">
              <section className="boot-section boot-delay-3" aria-label="Fund overview">
                <FundOverview />
              </section>
              <section className="boot-section boot-delay-4" aria-label="Deposit and withdraw">
                <InvestPanel />
              </section>
              <section className="boot-section boot-delay-5" aria-label="Queue status">
                <QueueStatus />
              </section>
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
                  <span className="status-indicator status-indicator-active feed-pulse-sync" />
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
