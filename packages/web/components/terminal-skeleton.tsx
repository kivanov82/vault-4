/**
 * Terminal-themed skeleton loading components.
 * Uses green/cyan scan-line animation matching the CRT aesthetic.
 */

type SkeletonProps = {
  className?: string
  variant?: "green" | "cyan"
}

export function TerminalSkeletonLine({ className = "", variant = "green" }: SkeletonProps) {
  const base = variant === "cyan" ? "terminal-skeleton-cyan" : "terminal-skeleton"
  return <div className={`${base} terminal-skeleton-line ${className}`} />
}

export function TerminalSkeletonText({ className = "", variant = "green" }: SkeletonProps & { size?: "sm" | "md" | "lg" }) {
  const base = variant === "cyan" ? "terminal-skeleton-cyan" : "terminal-skeleton"
  return <div className={`${base} terminal-skeleton-line ${className}`} />
}

export function TerminalSkeletonBlock({ className = "" }: { className?: string }) {
  return <div className={`terminal-skeleton-chart ${className}`} />
}
