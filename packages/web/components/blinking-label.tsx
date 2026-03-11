"use client"

interface BlinkingLabelProps {
  text: string
  className?: string
  prefix?: string
  color?: "green" | "cyan" | "amber"
}

const prefixMap: Record<string, string> = {
  ">": ">",
  "$": "$",
  "#": "#",
  "::": "::",
  "//": "//",
}

const colorClasses = {
  green: {
    dot: "bg-primary",
    text: "text-muted-foreground",
  },
  cyan: {
    dot: "bg-[color:var(--terminal-cyan)]",
    text: "text-[color:var(--terminal-cyan-dim)]",
  },
  amber: {
    dot: "bg-[color:var(--terminal-amber)]",
    text: "text-[color:var(--terminal-amber-dim)]",
  },
}

export function BlinkingLabel({
  text,
  className = "",
  prefix = ">",
  color = "green",
}: BlinkingLabelProps) {
  const colors = colorClasses[color]
  const pfx = prefixMap[prefix] ?? prefix

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <span className={`inline-block w-2 h-2 ${colors.dot} animate-pulse`} />
      <span className={`text-xs ${colors.text} uppercase tracking-wider`}>
        {pfx} {text}
      </span>
    </div>
  )
}
