"use client"

import { useEffect, useState } from "react"

const BOOT_MESSAGES = [
  "INITIALIZING VAULT_4 NEURAL INTERFACE...",
  "LOADING HYPERLIQUID PROTOCOL...",
  "ESTABLISHING SECURE CONNECTION...",
  "CALIBRATING AI TRADING MODULES...",
  "SYNCING BLOCKCHAIN DATA...",
  "SYSTEM READY_",
]

export function BootSequence({ onComplete }: { onComplete: () => void }) {
  const [currentLine, setCurrentLine] = useState(0)
  const [currentText, setCurrentText] = useState("")
  const [showCursor, setShowCursor] = useState(true)

  useEffect(() => {
    const cursorInterval = setInterval(() => {
      setShowCursor((prev) => !prev)
    }, 500)
    return () => clearInterval(cursorInterval)
  }, [])

  useEffect(() => {
    if (currentLine >= BOOT_MESSAGES.length) {
      const timeout = setTimeout(onComplete, 800)
      return () => clearTimeout(timeout)
    }

    const message = BOOT_MESSAGES[currentLine]
    let charIndex = 0

    const typeInterval = setInterval(() => {
      if (charIndex <= message.length) {
        setCurrentText(message.slice(0, charIndex))
        charIndex++
      } else {
        clearInterval(typeInterval)
        setTimeout(() => {
          setCurrentLine((prev) => prev + 1)
          setCurrentText("")
        }, 200)
      }
    }, 20)

    return () => clearInterval(typeInterval)
  }, [currentLine, onComplete])

  return (
    <div className="fixed inset-0 bg-background z-[200] flex items-center justify-center p-4">
      <div className="max-w-lg w-full">
        <div className="terminal-border p-4 font-mono text-xs md:text-sm">
          <div className="text-primary mb-4 text-center">
            <pre className="text-[8px] md:text-[10px] leading-tight glow-text">{`
██╗   ██╗ █████╗ ██╗   ██╗██╗  ████████╗    ██╗  ██╗
██║   ██║██╔══██╗██║   ██║██║  ╚══██╔══╝    ██║  ██║
██║   ██║███████║██║   ██║██║     ██║       ███████║
╚██╗ ██╔╝██╔══██║██║   ██║██║     ██║       ╚════██║
 ╚████╔╝ ██║  ██║╚██████╔╝███████╗██║            ██║
  ╚═══╝  ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝            ╚═╝
            `}</pre>
          </div>
          
          <div className="space-y-1 text-muted-foreground">
            {BOOT_MESSAGES.slice(0, currentLine).map((msg, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-primary">[OK]</span>
                <span>{msg}</span>
              </div>
            ))}
            {currentLine < BOOT_MESSAGES.length && (
              <div className="flex items-center gap-2">
                <span className="text-primary animate-pulse">[..]</span>
                <span>
                  {currentText}
                  <span className={showCursor ? "opacity-100" : "opacity-0"}>_</span>
                </span>
              </div>
            )}
          </div>

          <div className="mt-4 pt-2 border-t border-border/50">
            <div className="h-1 bg-secondary overflow-hidden">
              <div 
                className="h-full bg-primary transition-all duration-200 ease-out"
                style={{ width: `${(currentLine / BOOT_MESSAGES.length) * 100}%` }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
