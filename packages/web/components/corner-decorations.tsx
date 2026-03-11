"use client"

export function CornerDecorations() {
  return (
    <>
      {/* Top Left */}
      <div className="fixed top-0 left-0 w-16 h-16 pointer-events-none z-50 hidden md:block">
        <svg viewBox="0 0 64 64" className="w-full h-full opacity-40">
          <path
            d="M0 20 L0 0 L20 0"
            fill="none"
            stroke="var(--terminal-green)"
            strokeWidth="1"
          />
          <path
            d="M0 12 L0 4 L8 4"
            fill="none"
            stroke="var(--terminal-green)"
            strokeWidth="1"
          />
          <circle cx="4" cy="4" r="2" fill="var(--terminal-green)" className="animate-pulse" />
        </svg>
      </div>

      {/* Top Right */}
      <div className="fixed top-0 right-0 w-16 h-16 pointer-events-none z-50 hidden md:block">
        <svg viewBox="0 0 64 64" className="w-full h-full opacity-40">
          <path
            d="M64 20 L64 0 L44 0"
            fill="none"
            stroke="var(--terminal-green)"
            strokeWidth="1"
          />
          <path
            d="M64 12 L64 4 L56 4"
            fill="none"
            stroke="var(--terminal-green)"
            strokeWidth="1"
          />
          <circle cx="60" cy="4" r="2" fill="var(--terminal-green)" className="animate-pulse" />
        </svg>
      </div>

      {/* Bottom Left */}
      <div className="fixed bottom-0 left-0 w-16 h-16 pointer-events-none z-50 hidden md:block">
        <svg viewBox="0 0 64 64" className="w-full h-full opacity-40">
          <path
            d="M0 44 L0 64 L20 64"
            fill="none"
            stroke="var(--terminal-green)"
            strokeWidth="1"
          />
          <path
            d="M0 52 L0 60 L8 60"
            fill="none"
            stroke="var(--terminal-green)"
            strokeWidth="1"
          />
          <circle cx="4" cy="60" r="2" fill="var(--terminal-green)" className="animate-pulse" />
        </svg>
      </div>

      {/* Bottom Right */}
      <div className="fixed bottom-0 right-0 w-16 h-16 pointer-events-none z-50 hidden md:block">
        <svg viewBox="0 0 64 64" className="w-full h-full opacity-40">
          <path
            d="M64 44 L64 64 L44 64"
            fill="none"
            stroke="var(--terminal-green)"
            strokeWidth="1"
          />
          <path
            d="M64 52 L64 60 L56 60"
            fill="none"
            stroke="var(--terminal-green)"
            strokeWidth="1"
          />
          <circle cx="60" cy="60" r="2" fill="var(--terminal-green)" className="animate-pulse" />
        </svg>
      </div>
    </>
  )
}
