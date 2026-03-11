import type React from "react"
import type { Metadata } from "next"
import { Fira_Code } from "next/font/google"
import { Analytics } from "@vercel/analytics/next"
import Providers from "./providers"
import "./globals.css"

const firaCode = Fira_Code({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
})

export const metadata: Metadata = {
  title: "Vault 4 - AI-driven fund-of-vaults",
  description:
    "AI fund-of-vaults on Hyperliquid. Ranks vault PnL, risk, and market regime, reallocates as conditions change, and auto TP/SL to lock gains and cut tails.",
  generator: "v0.app",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${firaCode.className} antialiased`}>
        <Providers>
          <div className="scanline-overlay" />
          <div className="crt-effect">{children}</div>
        </Providers>
        <Analytics />
      </body>
    </html>
  )
}
