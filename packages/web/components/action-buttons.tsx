"use client"

export function ActionButtons() {
  const actions = [
    { label: "DEPOSIT", icon: "[>>]" },
    { label: "WITHDRAW", icon: "[<<]" },
    { label: "TRANSFER", icon: "[<>]" },
    { label: "TRADE", icon: "[##]" },
  ]

  return (
    <div className="grid grid-cols-4 gap-2">
      {actions.map((action) => (
        <button
          key={action.label}
          className="terminal-button-locked py-2 px-1 text-xs flex flex-col items-center gap-1"
          disabled
        >
          <span className="text-xs font-bold">{action.icon}</span>
          <span className="hidden sm:inline text-[10px]">{action.label}</span>
          <span className="text-[8px] opacity-50 hidden sm:inline">LOCKED</span>
        </button>
      ))}
    </div>
  )
}
