"use client"

import { useEffect, useState } from "react"

type Props = {
  onRetry?: () => void
}

export function ConnectionError({ onRetry }: Props) {
  const [dots, setDots] = useState("")

  useEffect(() => {
    const interval = setInterval(() => {
      setDots((prev) => (prev.length >= 3 ? "" : prev + "."))
    }, 500)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="terminal-border p-4 text-center space-y-3" style={{ borderColor: "var(--terminal-red)" }}>
      <div className="flex items-center justify-center gap-2">
        <span
          className="inline-block w-2 h-2 rounded-full"
          style={{ background: "var(--terminal-red)", boxShadow: "0 0 6px var(--terminal-red-glow)" }}
        />
        <span className="text-xs text-destructive font-bold tracking-wider">
          CONNECTION LOST
        </span>
      </div>

      <div className="text-xs text-destructive/70 font-mono space-y-1">
        <p>ERR::API_UNREACHABLE — upstream timeout</p>
        <p className="text-[10px] text-muted-foreground">
          Retrying{dots}
        </p>
      </div>

      {onRetry && (
        <button
          onClick={onRetry}
          className="terminal-button px-4 py-2 text-xs mt-2"
          style={{ borderColor: "var(--terminal-red)", color: "var(--terminal-red)" }}
        >
          [ RETRY ]
        </button>
      )}
    </div>
  )
}
