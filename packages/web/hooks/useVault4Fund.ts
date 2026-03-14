"use client"

import { useReadContracts, useReadContract } from "wagmi"
import { useAccount } from "wagmi"
import { vault4FundAbi, USDC_ADDRESS, erc20Abi } from "@/lib/vault4fund-abi"
import { formatUnits } from "viem"

const VAULT_ADDRESS = process.env.NEXT_PUBLIC_VAULT4FUND_ADDRESS as `0x${string}` | undefined

/** Parse 6-decimal bigint to number (USDC and V4FUND shares) */
function to6Dec(value: bigint | undefined): number {
  if (value === undefined) return 0
  return Number(formatUnits(value, 6))
}

/** Parse 18-decimal bigint to number (sharePrice, highWaterMark) */
function to18Dec(value: bigint | undefined): number {
  if (value === undefined) return 0
  return Number(formatUnits(value, 18))
}

/** Read global fund state */
export function useFundState() {
  const contract = { address: VAULT_ADDRESS!, abi: vault4FundAbi } as const

  const { data, isLoading, refetch } = useReadContracts({
    contracts: [
      { ...contract, functionName: "totalAssets" },        // 0: 6 dec
      { ...contract, functionName: "sharePrice" },         // 1: 18 dec
      { ...contract, functionName: "totalSupply" },        // 2: 6 dec
      { ...contract, functionName: "availableForInstantWithdraw" }, // 3: 6 dec
      { ...contract, functionName: "epoch" },              // 4: uint
      { ...contract, functionName: "paused" },             // 5: bool
      { ...contract, functionName: "pendingDeposits" },    // 6: 6 dec
      { ...contract, functionName: "pendingWithdraws" },   // 7: 6 dec (shares)
      { ...contract, functionName: "depositQueueLength" }, // 8: uint
      { ...contract, functionName: "withdrawQueueLength" },// 9: uint
      { ...contract, functionName: "highWaterMark" },      // 10: 18 dec
      { ...contract, functionName: "deployedToL1" },       // 11: 6 dec
      { ...contract, functionName: "depositQueueHead" },   // 12: uint
    ],
    query: { enabled: !!VAULT_ADDRESS, refetchInterval: 15_000 },
  })

  const results = data?.map((d) => d.result) ?? []

  return {
    isLoading,
    refetch,
    tvl: to6Dec(results[0] as bigint | undefined),
    sharePrice: to18Dec(results[1] as bigint | undefined),
    totalSupply: to6Dec(results[2] as bigint | undefined),
    instantLiquidity: to6Dec(results[3] as bigint | undefined),
    epoch: Number(results[4] ?? 0),
    paused: (results[5] as boolean) ?? false,
    pendingDepositsUsdc: to6Dec(results[6] as bigint | undefined),
    pendingWithdrawsShares: to6Dec(results[7] as bigint | undefined),
    depositQueueLen: Number(results[8] ?? 0),
    withdrawQueueLen: Number(results[9] ?? 0),
    highWaterMark: to18Dec(results[10] as bigint | undefined),
    deployedToL1: to6Dec(results[11] as bigint | undefined),
    depositQueueHead: Number(results[12] ?? 0),
    configured: !!VAULT_ADDRESS,
  }
}

/** Read investor-specific data: shares, USDC balance, allowance */
export function useInvestorState() {
  const { address } = useAccount()

  const { data: sharesRaw, isLoading: loadingShares, refetch: refetchShares } = useReadContract({
    address: VAULT_ADDRESS!,
    abi: vault4FundAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!VAULT_ADDRESS && !!address, refetchInterval: 15_000 },
  })

  const { data: usdcBalanceRaw, isLoading: loadingUsdc, refetch: refetchUsdc } = useReadContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 15_000 },
  })

  const { data: allowanceRaw, isLoading: loadingAllowance, refetch: refetchAllowance } = useReadContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "allowance",
    args: address && VAULT_ADDRESS ? [address, VAULT_ADDRESS] : undefined,
    query: { enabled: !!address && !!VAULT_ADDRESS, refetchInterval: 15_000 },
  })

  const refetch = () => { refetchShares(); refetchUsdc(); refetchAllowance() }

  return {
    isLoading: loadingShares || loadingUsdc || loadingAllowance,
    refetch,
    shares: to6Dec(sharesRaw as bigint | undefined),
    usdcBalance: to6Dec(usdcBalanceRaw as bigint | undefined),
    allowance: to6Dec(allowanceRaw as bigint | undefined),
  }
}
