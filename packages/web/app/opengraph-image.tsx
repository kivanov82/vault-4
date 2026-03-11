import { ImageResponse } from "next/og"

export const runtime = "edge"
export const alt = "Vault 4 - AI-driven fund-of-vaults on Hyperliquid"
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

export default async function OGImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          background: "linear-gradient(145deg, #050505 0%, #0d1a0d 50%, #050505 100%)",
          fontFamily: "monospace",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Scanline overlay effect */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundImage:
              "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,255,65,0.03) 2px, rgba(0,255,65,0.03) 4px)",
            display: "flex",
          }}
        />

        {/* Border frame */}
        <div
          style={{
            position: "absolute",
            top: 16,
            left: 16,
            right: 16,
            bottom: 16,
            border: "1px solid rgba(0,255,65,0.25)",
            display: "flex",
          }}
        />
        <div
          style={{
            position: "absolute",
            top: 20,
            left: 20,
            right: 20,
            bottom: 20,
            border: "1px solid rgba(0,255,65,0.12)",
            display: "flex",
          }}
        />

        {/* Corner brackets */}
        {/* Top-left */}
        <div
          style={{
            position: "absolute",
            top: 32,
            left: 32,
            width: 40,
            height: 40,
            borderTop: "2px solid #00ff41",
            borderLeft: "2px solid #00ff41",
            display: "flex",
          }}
        />
        {/* Top-right */}
        <div
          style={{
            position: "absolute",
            top: 32,
            right: 32,
            width: 40,
            height: 40,
            borderTop: "2px solid #00ff41",
            borderRight: "2px solid #00ff41",
            display: "flex",
          }}
        />
        {/* Bottom-left */}
        <div
          style={{
            position: "absolute",
            bottom: 32,
            left: 32,
            width: 40,
            height: 40,
            borderBottom: "2px solid #00ff41",
            borderLeft: "2px solid #00ff41",
            display: "flex",
          }}
        />
        {/* Bottom-right */}
        <div
          style={{
            position: "absolute",
            bottom: 32,
            right: 32,
            width: 40,
            height: 40,
            borderBottom: "2px solid #00ff41",
            borderRight: "2px solid #00ff41",
            display: "flex",
          }}
        />

        {/* Main content */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 0,
          }}
        >
          {/* V4 mark */}
          <div
            style={{
              fontSize: 160,
              fontWeight: 700,
              color: "#00ff41",
              letterSpacing: "-0.02em",
              lineHeight: 1,
              textShadow:
                "0 0 40px rgba(0,255,65,0.6), 0 0 80px rgba(0,255,65,0.3), 0 0 120px rgba(0,255,65,0.15)",
              display: "flex",
            }}
          >
            V4
          </div>

          {/* Divider line */}
          <div
            style={{
              width: 320,
              height: 1,
              background:
                "linear-gradient(90deg, transparent, #00ff41, transparent)",
              marginTop: 16,
              marginBottom: 24,
              display: "flex",
            }}
          />

          {/* Tagline */}
          <div
            style={{
              fontSize: 24,
              color: "rgba(0,255,65,0.75)",
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              display: "flex",
            }}
          >
            AI Fund-of-Vaults
          </div>

          {/* Subtitle */}
          <div
            style={{
              fontSize: 16,
              color: "rgba(0,200,220,0.6)",
              letterSpacing: "0.15em",
              marginTop: 12,
              display: "flex",
            }}
          >
            Automated trading on Hyperliquid
          </div>
        </div>

        {/* Bottom status bar */}
        <div
          style={{
            position: "absolute",
            bottom: 44,
            left: 80,
            right: 80,
            display: "flex",
            justifyContent: "space-between",
            fontSize: 12,
            color: "rgba(0,255,65,0.35)",
            letterSpacing: "0.1em",
          }}
        >
          <span>SYS::ACTIVE</span>
          <span>vault-4.xyz</span>
          <span>PROTOCOL::HYPERLIQUID</span>
        </div>
      </div>
    ),
    { ...size }
  )
}
