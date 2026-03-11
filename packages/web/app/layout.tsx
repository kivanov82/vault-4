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
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://vault-4.xyz"),
  title: "Vault 4 - AI-driven fund-of-vaults",
  description:
    "AI fund-of-vaults on Hyperliquid. Ranks vault PnL, risk, and market regime, reallocates as conditions change, and auto TP/SL to lock gains and cut tails.",
  manifest: "/manifest.json",
  alternates: {
    canonical: "/",
  },
  robots: {
    index: true,
    follow: true,
  },
  openGraph: {
    title: "Vault 4 - AI-driven fund-of-vaults",
    description:
      "AI fund-of-vaults on Hyperliquid. Ranks vault PnL, risk, and market regime, reallocates as conditions change.",
    siteName: "Vault 4",
    url: "https://vault-4.xyz",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Vault 4 - AI-driven fund-of-vaults",
    description:
      "AI fund-of-vaults on Hyperliquid. Automated PnL ranking, risk allocation, and TP/SL.",
  },
  keywords: ["Hyperliquid", "vault", "DeFi", "fund-of-vaults", "AI trading", "automated trading"],
  other: {
    "theme-color": "#00ff41",
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="dark">
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "WebApplication",
              name: "Vault 4",
              url: "https://vault-4.xyz",
              description:
                "AI-driven fund-of-vaults on Hyperliquid. Automated PnL ranking, risk allocation, and TP/SL.",
              applicationCategory: "FinanceApplication",
              operatingSystem: "Web",
              offers: {
                "@type": "Offer",
                price: "0",
                priceCurrency: "USD",
              },
            }),
          }}
        />
      </head>
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
