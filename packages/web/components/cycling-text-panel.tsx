"use client"

import { useEffect, useState, useCallback } from "react"

const MESSAGES = [
  { text: "Vault 4 is an AI fund-of-vaults on Hyperliquid. It ranks vault PnL, risk, and market regime, reallocates as conditions change, and auto TP/SL to lock gains and cut tails.", type: "info" as const },
  { text: "WARNING: Trading cryptocurrencies involves substantial risk of loss. Past performance does not guarantee future results. Only deposit funds you can afford to lose.", type: "warn" as const },
  { text: "DISCLAIMER: This protocol is provided AS-IS without warranties. Smart contract interactions are irreversible. Verify all transactions before signing.", type: "warn" as const },
  { text: "RISK NOTICE: Leverage trading can result in liquidation. The vault may experience drawdowns during volatile market conditions. DYOR before depositing.", type: "warn" as const },
]

export function CyclingTextPanel({ className = "" }: { className?: string }) {
  const [messageIndex, setMessageIndex] = useState(0)
  const [displayedText, setDisplayedText] = useState("")
  const [phase, setPhase] = useState<"typing" | "pause" | "clear">("typing")
  const [charIndex, setCharIndex] = useState(0)

  const current = MESSAGES[messageIndex]
  const isWarning = current.type === "warn"
  const typeSpeed = 30
  const pauseDuration = 5000

  const skipToNext = useCallback(() => {
    setDisplayedText("")
    setCharIndex(0)
    setMessageIndex((prev) => (prev + 1) % MESSAGES.length)
    setPhase("typing")
  }, [])

  useEffect(() => {
    let timeout: NodeJS.Timeout

    if (phase === "typing") {
      if (charIndex < current.text.length) {
        timeout = setTimeout(() => {
          setDisplayedText(current.text.slice(0, charIndex + 1))
          setCharIndex(charIndex + 1)
        }, typeSpeed)
      } else {
        setPhase("pause")
      }
    } else if (phase === "pause") {
      timeout = setTimeout(() => {
        setPhase("clear")
      }, pauseDuration)
    } else if (phase === "clear") {
      setDisplayedText("")
      setCharIndex(0)
      setMessageIndex((prev) => (prev + 1) % MESSAGES.length)
      setPhase("typing")
    }

    return () => clearTimeout(timeout)
  }, [phase, charIndex, current.text])

  const borderClass = isWarning ? "terminal-border-amber" : "terminal-border"
  const textColor = isWarning ? "text-[color:var(--terminal-amber)]" : "text-primary"
  const labelColor = isWarning ? "text-[color:var(--terminal-amber-dim)]" : "text-primary"
  const cursorColor = isWarning ? "var(--terminal-amber)" : "#00ff41"

  return (
    <div className={`${borderClass} p-3 ${className}`}>
      <div className="flex items-center gap-2 mb-2">
        <span className={`text-xs ${isWarning ? "text-[color:var(--terminal-amber-dim)]" : "text-muted-foreground"}`}>
          {isWarning ? "!" : ">"}
        </span>
        <span className={`text-xs ${labelColor} font-semibold tracking-wider`}>
          {isWarning ? "SYS_WARNING" : "SYSTEM_MESSAGE"}
        </span>
        <span className={`flex-1 h-px ${isWarning ? "bg-[color:var(--terminal-amber-dim)]" : "bg-border"}`} />
        <button
          onClick={skipToNext}
          className={`text-xs ${isWarning ? "text-[color:var(--terminal-amber-dim)] hover:text-[color:var(--terminal-amber)]" : "text-muted-foreground hover:text-primary"} transition-colors cursor-pointer`}
          title="Next message"
        >
          [{String(messageIndex + 1).padStart(2, "0")}/{String(MESSAGES.length).padStart(2, "0")}]
        </button>
      </div>
      <div className="min-h-[3rem] md:min-h-[4rem]">
        <p className={`text-xs ${textColor} leading-relaxed`}>
          {displayedText}
          <span
            className={`inline-block ml-0.5 ${phase === "pause" ? "animate-pulse" : ""}`}
            style={{ color: cursorColor }}
          >
            _
          </span>
        </p>
      </div>
    </div>
  )
}
