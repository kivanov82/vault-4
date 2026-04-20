"use client"

export function AmbientGlow() {
  return (
    <div aria-hidden className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
      <div className="ambient-blob ambient-blob-green" />
      <div className="ambient-blob ambient-blob-cyan" />
      <div className="ambient-blob ambient-blob-amber" />
      <div className="ambient-scan" />
    </div>
  )
}
