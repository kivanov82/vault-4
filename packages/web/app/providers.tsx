"use client"

import type React from "react"
import { useState } from "react"
import { WagmiProvider } from "wagmi"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { wagmiConfig } from "@/lib/wagmi"

function bigIntSafeHashKey(queryKey: readonly unknown[]): string {
  return JSON.stringify(queryKey, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value
  )
}

export default function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            queryKeyHashFn: bigIntSafeHashKey,
            staleTime: 60_000,
          },
        },
      })
  )

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  )
}
