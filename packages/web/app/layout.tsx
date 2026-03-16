import type React from "react"
import type { Metadata } from "next"
import { Fira_Code } from "next/font/google"
import { Analytics } from "@vercel/analytics/next"
import Providers from "./providers"
import "./globals.css"

const firaCode = Fira_Code({
  subsets: ["latin"],
  weight: ["400", "600"],
})

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://vault-4.xyz"),
  title: "Vault 4 | AI DeFi Vault — Automated Hyperliquid Trading",
  description:
    "AI-managed ERC-4626 vault on Hyperliquid. Claude AI ranks 100+ vaults by PnL, risk and market regime, allocates with a barbell strategy, and rebalances every 48 hours. Non-custodial, daily settlement at 3PM CET.",
  manifest: "/manifest.json",
  alternates: {
    canonical: "/",
  },
  robots: {
    index: true,
    follow: true,
  },
  openGraph: {
    title: "Vault 4 | AI DeFi Vault — Automated Hyperliquid Trading",
    description:
      "AI-managed ERC-4626 vault on Hyperliquid. Claude AI ranks 100+ vaults, allocates with a barbell strategy, rebalances every 48h.",
    siteName: "Vault 4",
    url: "https://vault-4.xyz",
    type: "website",
    locale: "en_US",
    images: [{ url: "/opengraph-image", width: 1200, height: 630, alt: "Vault 4 — AI DeFi Vault on Hyperliquid" }],
  },
  twitter: {
    card: "summary_large_image",
    site: "@vault4_xyz",
    creator: "@vault4_xyz",
    title: "Vault 4 | AI DeFi Vault — Automated Hyperliquid Trading",
    description:
      "AI-managed ERC-4626 vault on Hyperliquid. Non-custodial, daily settlement, barbell allocation across 100+ vaults.",
  },
  keywords: [
    "AI DeFi vault", "Hyperliquid vault", "ERC-4626 vault", "automated trading vault",
    "AI portfolio management crypto", "fund-of-vaults", "AI trading", "DeFi", "Hyperliquid",
    "autonomous AI agent", "vault management", "crypto portfolio automation",
  ],
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
            __html: JSON.stringify([
              {
                "@context": "https://schema.org",
                "@type": "WebApplication",
                name: "Vault 4",
                url: "https://vault-4.xyz",
                description:
                  "AI-managed ERC-4626 vault on Hyperliquid. Claude AI ranks 100+ vaults, allocates with a barbell strategy, and rebalances every 48 hours.",
                applicationCategory: "FinanceApplication",
                operatingSystem: "Web",
                offers: {
                  "@type": "Offer",
                  price: "0",
                  priceCurrency: "USD",
                },
              },
              {
                "@context": "https://schema.org",
                "@type": "Organization",
                name: "Vault 4",
                url: "https://vault-4.xyz",
                sameAs: ["https://x.com/vault4_xyz"],
              },
            ]),
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
