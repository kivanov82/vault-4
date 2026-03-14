"use client"

import { useWriteContract, useWaitForTransactionReceipt } from "wagmi"
import { parseUnits } from "viem"
import { vault4FundAbi, USDC_ADDRESS, erc20Abi } from "@/lib/vault4fund-abi"

const VAULT_ADDRESS = process.env.NEXT_PUBLIC_VAULT4FUND_ADDRESS as `0x${string}` | undefined
export function useApproveUsdc() {
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash })

  const approve = (usdcAmount: number) => {
    if (!VAULT_ADDRESS) return
    const amount = parseUnits(usdcAmount.toString(), 6)
    writeContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: "approve",
      args: [VAULT_ADDRESS, amount],
    })
  }

  return { approve, isPending, isConfirming, isSuccess, error, reset }
}

export function useRequestDeposit() {
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash })

  const deposit = (usdcAmount: number) => {
    if (!VAULT_ADDRESS) return
    const assets = parseUnits(usdcAmount.toString(), 6)
    writeContract({
      address: VAULT_ADDRESS,
      abi: vault4FundAbi,
      functionName: "requestDeposit",
      args: [assets],
    })
  }

  return { deposit, isPending, isConfirming, isSuccess, error, hash, reset }
}

export function useRequestWithdraw() {
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash })

  const withdraw = (shareAmount: number) => {
    if (!VAULT_ADDRESS) return
    const shares = parseUnits(shareAmount.toString(), 6)
    writeContract({
      address: VAULT_ADDRESS,
      abi: vault4FundAbi,
      functionName: "requestWithdraw",
      args: [shares],
    })
  }

  return { withdraw, isPending, isConfirming, isSuccess, error, hash, reset }
}

export function useInstantWithdraw() {
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash })

  const instantWithdraw = (shareAmount: number) => {
    if (!VAULT_ADDRESS) return
    const shares = parseUnits(shareAmount.toString(), 6)
    writeContract({
      address: VAULT_ADDRESS,
      abi: vault4FundAbi,
      functionName: "instantWithdraw",
      args: [shares],
    })
  }

  return { instantWithdraw, isPending, isConfirming, isSuccess, error, hash, reset }
}

export function useCancelDeposit() {
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash })

  const cancel = (index: bigint) => {
    if (!VAULT_ADDRESS) return
    writeContract({
      address: VAULT_ADDRESS,
      abi: vault4FundAbi,
      functionName: "cancelDeposit",
      args: [index],
    })
  }

  return { cancel, isPending, isConfirming, isSuccess, error, hash, reset }
}

export function useCancelWithdraw() {
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash })

  const cancel = (index: bigint) => {
    if (!VAULT_ADDRESS) return
    writeContract({
      address: VAULT_ADDRESS,
      abi: vault4FundAbi,
      functionName: "cancelWithdraw",
      args: [index],
    })
  }

  return { cancel, isPending, isConfirming, isSuccess, error, hash, reset }
}
