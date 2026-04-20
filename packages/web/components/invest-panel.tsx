"use client"

import { useState, useEffect, useCallback } from "react"
import { useAccount } from "wagmi"
import { BlinkingLabel } from "./blinking-label"
import { TerminalSkeletonLine } from "./terminal-skeleton"
import { useFundState, useInvestorState } from "@/hooks/useVault4Fund"
import {
  useApproveUsdc,
  useRequestDeposit,
  useRequestWithdraw,
  useInstantWithdraw,
} from "@/hooks/useVault4FundWrite"

type Mode = "DEPOSIT" | "WITHDRAW"

const MIN_AMOUNT = 10

export function InvestPanel() {
  const { isConnected } = useAccount()
  const fund = useFundState()
  const investor = useInvestorState()
  const [mode, setMode] = useState<Mode>("DEPOSIT")
  const [amount, setAmount] = useState("")
  const [useInstant, setUseInstant] = useState(false)
  const [justApproved, setJustApproved] = useState(false)

  const approve = useApproveUsdc()
  const deposit = useRequestDeposit()
  const withdraw = useRequestWithdraw()
  const instant = useInstantWithdraw()

  if (!fund.configured) return null

  const parsedAmount = Number(amount) || 0
  const needsApproval = mode === "DEPOSIT" && parsedAmount > investor.allowance
  const shareEquivalent =
    mode === "DEPOSIT"
      ? fund.sharePrice > 0 ? parsedAmount / fund.sharePrice : 0
      : parsedAmount
  const usdcEquivalent =
    mode === "WITHDRAW" ? parsedAmount * fund.sharePrice : parsedAmount

  // Validation
  const depositTooLow = mode === "DEPOSIT" && parsedAmount > 0 && parsedAmount < MIN_AMOUNT
  const withdrawTooLow = mode === "WITHDRAW" && parsedAmount > 0 && usdcEquivalent < MIN_AMOUNT
  const insufficientUsdc = mode === "DEPOSIT" && parsedAmount > investor.usdcBalance
  const insufficientShares = mode === "WITHDRAW" && parsedAmount > investor.shares
  const canInstant =
    mode === "WITHDRAW" && usdcEquivalent <= fund.instantLiquidity && fund.instantLiquidity > 0
  const isProcessing =
    approve.isPending || (approve.isConfirming && !approve.error) ||
    deposit.isPending || (deposit.isConfirming && !deposit.error) ||
    withdraw.isPending || (withdraw.isConfirming && !withdraw.error) ||
    instant.isPending || (instant.isConfirming && !instant.error)

  const isDisabled =
    parsedAmount <= 0 ||
    depositTooLow ||
    withdrawTooLow ||
    insufficientUsdc ||
    insufficientShares ||
    fund.paused ||
    isProcessing

  // Refetch investor state after approval so needsApproval recalculates
  useEffect(() => {
    if (approve.isSuccess) {
      investor.refetch()
      approve.reset()
      setJustApproved(true)
      const timer = setTimeout(() => setJustApproved(false), 4000)
      return () => clearTimeout(timer)
    }
  }, [approve.isSuccess])

  // Reset on success
  useEffect(() => {
    if (deposit.isSuccess || withdraw.isSuccess || instant.isSuccess) {
      setAmount("")
      fund.refetch()
      investor.refetch()
    }
  }, [deposit.isSuccess, withdraw.isSuccess, instant.isSuccess])

  const handleSubmit = useCallback(() => {
    if (isDisabled) return
    if (mode === "DEPOSIT") {
      if (needsApproval) {
        approve.approve(parsedAmount)
      } else {
        deposit.deposit(parsedAmount)
      }
    } else {
      if (useInstant && canInstant) {
        instant.instantWithdraw(parsedAmount)
      } else {
        withdraw.withdraw(parsedAmount)
      }
    }
  }, [mode, parsedAmount, needsApproval, useInstant, canInstant, isDisabled])

  const activeError = deposit.error || withdraw.error || instant.error || approve.error
  const activeSuccess = deposit.isSuccess || withdraw.isSuccess || instant.isSuccess
  const activeHash = deposit.hash || withdraw.hash || instant.hash

  return (
    <div className="terminal-border-hero p-3">
      <BlinkingLabel text="INVEST" prefix=">>" as="h2" />

      {/* Mode tabs */}
      <div className="flex gap-1 mt-3">
        {(["DEPOSIT", "WITHDRAW"] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => { setMode(m); setAmount(""); deposit.reset(); withdraw.reset(); instant.reset(); approve.reset() }}
            className={`flex-1 py-2.5 text-xs font-semibold tracking-wider transition-all ${
              mode === m
                ? "terminal-button bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-primary border border-transparent hover:border-primary/30"
            }`}
          >
            [{m}]
          </button>
        ))}
      </div>

      {/* Balances */}
      <div className="flex justify-between mt-3 text-[10px]">
        {mode === "DEPOSIT" ? (
          <>
            <span className="text-[color:var(--terminal-green-dim)]">
              USDC_BAL: <span className="text-[color:var(--terminal-green)]">{formatUsd(investor.usdcBalance)}</span>
            </span>
            <span className="flex items-center gap-2">
              <BridgeLink />
              {investor.usdcBalance > 0 && (
                <button
                  onClick={() => setAmount(String(investor.usdcBalance))}
                  className="text-[color:var(--terminal-cyan-dim)] hover:text-[color:var(--terminal-cyan)] transition-colors"
                >
                  [MAX]
                </button>
              )}
            </span>
          </>
        ) : (
          <>
            <span className="text-[color:var(--terminal-green-dim)]">
              SHARES: <span className="text-[color:var(--terminal-green)]">{formatShares(investor.shares)}</span>
              <span className="text-[color:var(--terminal-green-dim)] ml-1">
                ({formatUsd(investor.shares * fund.sharePrice)})
              </span>
            </span>
            <button
              onClick={() => setAmount(String(investor.shares))}
              className="text-[color:var(--terminal-cyan-dim)] hover:text-[color:var(--terminal-cyan)] transition-colors"
            >
              [MAX]
            </button>
          </>
        )}
      </div>
      {mode === "DEPOSIT" && isConnected && investor.usdcBalance === 0 && (
        <div className="mt-1.5 text-[10px] text-[color:var(--terminal-amber-dim)]">
          ! USDC on HyperEVM required — bridge via link above
        </div>
      )}

      {/* Input */}
      <div className="mt-2 terminal-border-inset p-2">
        <div className="flex items-center gap-2">
          <span className="text-[color:var(--terminal-green)] text-sm">{">"}</span>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={mode === "DEPOSIT" ? "0.00 USDC" : "0.00 shares"}
            className="flex-1 bg-transparent text-sm text-[color:var(--terminal-green)] placeholder:text-[color:var(--terminal-green-dim)] outline-none font-mono"
            min={0}
            step="any"
          />
          <span className="text-xs text-[color:var(--terminal-green-dim)]">
            {mode === "DEPOSIT" ? "USDC" : "SHARES"}
          </span>
        </div>
        {parsedAmount > 0 && (
          <div className="mt-1 text-[10px] text-[color:var(--terminal-cyan-dim)] pl-5">
            {mode === "DEPOSIT"
              ? `≈ ${formatShares(shareEquivalent)} shares`
              : `MY_HOLDINGS ≈ ${formatUsd(usdcEquivalent)}`
            }
          </div>
        )}
      </div>

      {/* Validation messages */}
      {depositTooLow && (
        <div className="mt-2 text-[10px] text-[color:var(--terminal-amber)]">
          ! MIN_DEPOSIT: {MIN_AMOUNT} USDC
        </div>
      )}
      {withdrawTooLow && (
        <div className="mt-2 text-[10px] text-[color:var(--terminal-amber)]">
          ! MIN_WITHDRAW: {MIN_AMOUNT} USDC ({formatShares(MIN_AMOUNT / fund.sharePrice)} shares)
        </div>
      )}
      {insufficientUsdc && (
        <div className="mt-2 text-[10px] text-destructive">
          ! INSUFFICIENT_USDC — <BridgeLink />
        </div>
      )}
      {insufficientShares && (
        <div className="mt-2 text-[10px] text-destructive">
          ! INSUFFICIENT_SHARES
        </div>
      )}
      {fund.paused && (
        <div className="mt-2 text-[10px] text-[color:var(--terminal-amber)] glow-text-amber">
          ! CONTRACT_PAUSED — DEPOSITS AND WITHDRAWALS DISABLED
        </div>
      )}

      {/* Instant withdraw toggle */}
      {mode === "WITHDRAW" && parsedAmount > 0 && (
        <div className="mt-2 flex items-center gap-2 text-[10px]">
          {canInstant ? (
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={useInstant}
                onChange={(e) => setUseInstant(e.target.checked)}
                className="accent-[var(--terminal-green)]"
              />
              <span className="text-[color:var(--terminal-green)]">INSTANT_WITHDRAW</span>
              <span className="text-[color:var(--terminal-green-dim)]">(liquidity available)</span>
            </label>
          ) : (
            <span className="text-[color:var(--terminal-amber-dim)]">
              QUEUED — processed at next 3PM CET settlement
            </span>
          )}
        </div>
      )}

      {/* Submit button */}
      <button
        onClick={handleSubmit}
        disabled={isDisabled || !isConnected}
        className={`w-full mt-3 py-3 text-xs font-bold tracking-wider transition-all ${
          isDisabled || !isConnected
            ? "terminal-button-locked"
            : justApproved && !needsApproval
              ? "terminal-button animate-[deposit-pulse_0.8s_ease-in-out_infinite] shadow-[0_0_12px_var(--terminal-green)]"
              : "terminal-button"
        }`}
      >
        {!isConnected
          ? "[ CONNECT WALLET ]"
          : isProcessing
            ? "[ PROCESSING... ]"
            : mode === "DEPOSIT"
              ? needsApproval
                ? "[ APPROVE USDC ]"
                : justApproved
                  ? "[ ✓ APPROVED — DEPOSIT NOW ]"
                  : "[ DEPOSIT ]"
              : useInstant && canInstant
                ? "[ INSTANT WITHDRAW ]"
                : "[ QUEUE WITHDRAWAL ]"
        }
      </button>

      {/* Status messages */}
      {activeError && (
        <div className="mt-2 text-[10px] text-destructive truncate">
          ERR: {(activeError as Error).message?.slice(0, 80)}
        </div>
      )}
      {activeSuccess && (
        <div className="mt-2 text-[10px] text-[color:var(--terminal-green-bright)] flex items-center gap-2 flex-wrap">
          <span>TX_CONFIRMED — {mode === "DEPOSIT" ? "deposit queued for settlement" : "withdrawal processed"}</span>
          {activeHash && (
            <a
              href={`https://app.hyperliquid.xyz/explorer/tx/${activeHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[color:var(--terminal-cyan)] hover:underline"
            >
              TX: {activeHash.slice(0, 10)}...
            </a>
          )}
        </div>
      )}

      {/* Settlement info */}
      <div className="mt-3 pt-2 border-t border-border/50 text-[10px] text-muted-foreground">
        <SettlementCountdown />
      </div>
    </div>
  )
}

function SettlementCountdown() {
  const [timeLeft, setTimeLeft] = useState("")

  useEffect(() => {
    const update = () => {
      const now = new Date()
      const utcHour = now.getUTCHours()
      const utcMin = now.getUTCMinutes()

      // 3PM CET = 14:00 UTC (winter) / 13:00 UTC (summer)
      // Approximate: use 14:00 UTC
      const targetHour = 14
      let hoursLeft = targetHour - utcHour
      let minsLeft = -utcMin

      if (hoursLeft < 0 || (hoursLeft === 0 && minsLeft <= 0)) {
        hoursLeft += 24
      }
      if (minsLeft < 0) {
        hoursLeft -= 1
        minsLeft += 60
      }

      setTimeLeft(`${hoursLeft}h ${String(minsLeft).padStart(2, "0")}m`)
    }
    update()
    const interval = setInterval(update, 60_000)
    return () => clearInterval(interval)
  }, [])

  return (
    <span>
      NEXT_SETTLEMENT: 3PM CET{timeLeft ? ` (in ${timeLeft})` : ""}
    </span>
  )
}

function BridgeLink() {
  return (
    <a
      href="https://jumper.exchange/?toChain=999&toToken=0xb88339CB7199b77E23DB6E890353E22632Ba630f"
      target="_blank"
      rel="noopener noreferrer"
      className="text-[color:var(--terminal-cyan)] hover:underline"
    >
      [JUMPER]
    </a>
  )
}

function formatUsd(value: number) {
  return `$${value.toFixed(2)}`
}

function formatShares(value: number) {
  return value.toFixed(2)
}
