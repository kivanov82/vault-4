import { createConfig, http } from "wagmi"
import { injected } from "wagmi/connectors"
import { defineChain } from "viem"

const rpcUrl = process.env.NEXT_PUBLIC_HYPERLIQUID_RPC ?? "https://rpc.hyperlend.finance"

export const hyperliquidChain = defineChain({
  id: 1337,
  name: "Hyperliquid",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: 6,
  },
  rpcUrls: {
    default: { http: [rpcUrl] },
  },
  blockExplorers: {
    default: { name: "Hyperliquid", url: "https://app.hyperliquid.xyz" },
  },
})

export const wagmiConfig = createConfig({
  chains: [hyperliquidChain],
  connectors: [injected({ shimDisconnect: true })],
  transports: {
    [hyperliquidChain.id]: http(rpcUrl),
  },
  ssr: true,
})
