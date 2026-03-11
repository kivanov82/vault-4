"use client"

import { useEffect, useState } from "react"

export function StatusBar() {
  const [stats, setStats] = useState({
    cpu: 0,
    mem: 0,
    net: 0,
  })

  useEffect(() => {
    const interval = setInterval(() => {
      setStats({
        cpu: Math.floor(Math.random() * 30) + 10,
        mem: Math.floor(Math.random() * 20) + 40,
        net: Math.floor(Math.random() * 100) + 50,
      })
    }, 2000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="fixed bottom-0 left-0 right-0 h-6 bg-background/95 border-t border-border z-40 px-4 flex items-center justify-between text-[10px] font-mono hidden md:flex">
      <div className="flex items-center gap-4">
        <span className="text-muted-foreground">
          SYS_STATUS: <span className="text-primary">OPERATIONAL</span>
        </span>
        <span className="text-muted-foreground">
          CPU: <span className="text-primary">{stats.cpu}%</span>
        </span>
        <span className="text-muted-foreground">
          MEM: <span className="text-primary">{stats.mem}%</span>
        </span>
        <span className="text-muted-foreground">
          NET: <span className="text-primary">{stats.net}KB/s</span>
        </span>
      </div>
      <div className="flex items-center gap-4">
        <span className="text-muted-foreground">
          PROTOCOL: <span className="text-primary">HYPERLIQUID</span>
        </span>
        <span className="text-muted-foreground">
          CHAIN_ID: <span className="text-primary">998</span>
        </span>
        <div className="flex items-center gap-1">
          <span className="w-2 h-2 bg-primary rounded-full animate-pulse" />
          <span className="text-primary">CONNECTED</span>
        </div>
      </div>
    </div>
  )
}
