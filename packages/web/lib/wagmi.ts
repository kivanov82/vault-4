import { createConfig, http } from "wagmi"
import { injected } from "wagmi/connectors"
import { defineChain } from "viem"

const rpcUrl = process.env.NEXT_PUBLIC_HYPERLIQUID_RPC ?? "https://rpc.hyperliquid.xyz/evm"

export const hyperliquidChain = defineChain({
  id: 999,
  name: "Hyperliquid",
  nativeCurrency: {
    name: "HYPE",
    symbol: "HYPE",
    decimals: 18,
  },
  rpcUrls: {
    default: { http: [rpcUrl] },
  },
  blockExplorers: {
    default: {
      name: "Hyperliquid Explorer",
      url: "https://app.hyperliquid.xyz/explorer",
    },
  },
  contracts: {
    multicall3: {
      address: "0xcA11bde05977b3631167028862bE2a173976CA11",
    },
  },
})

export const wagmiConfig = createConfig({
  chains: [hyperliquidChain],
  connectors: [injected({ shimDisconnect: true })],
  multiInjectedProviderDiscovery: true,
  transports: {
    [hyperliquidChain.id]: http(rpcUrl, {
      batch: true,
    }),
  },
  ssr: true,
})
