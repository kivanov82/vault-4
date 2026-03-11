"use client"

import { useEffect, useState } from "react"

interface TypingTextProps {
  text: string
  className?: string
  speed?: number
  showCursor?: boolean
}

export function TypingText({ text, className = "", speed = 50, showCursor = true }: TypingTextProps) {
  const [displayedText, setDisplayedText] = useState("")
  const [isComplete, setIsComplete] = useState(false)

  useEffect(() => {
    setDisplayedText("")
    setIsComplete(false)

    let index = 0
    const interval = setInterval(() => {
      if (index < text.length) {
        setDisplayedText(text.slice(0, index + 1))
        index++
      } else {
        setIsComplete(true)
        clearInterval(interval)
      }
    }, speed)

    return () => clearInterval(interval)
  }, [text, speed])

  return (
    <span className={className}>
      {displayedText}
      {showCursor && !isComplete && <span className="animate-pulse">█</span>}
    </span>
  )
}
