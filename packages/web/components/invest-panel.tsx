"use client"

import { useState, useEffect, useCallback } from "react"
import { useAccount, useConnect } from "wagmi"
import { hyperliquidChain } from "@/lib/wagmi"
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
  const { connect, connectors } = useConnect()
  const fund = useFundState()
  const investor = useInvestorState()
  const [mode, setMode] = useState<Mode>("DEPOSIT")
  const [amount, setAmount] = useState("")
  const [useInstant, setUseInstant] = useState(true)
  const [justApproved, setJustApproved] = useState(false)

  const approve = useApproveUsdc()
  const deposit = useRequestDeposit()
  const withdraw = useRequestWithdraw()
  const instant = useInstantWithdraw()

  if (!fund.configured) return null

  // Always input USDC. For WITHDRAW, derive shares from USDC ÷ sharePrice.
  const parsedUsdc = Number(amount) || 0
  const sharesForWithdraw =
    mode === "WITHDRAW" && fund.sharePrice > 0 ? parsedUsdc / fund.sharePrice : 0
  const sharesForDepositPreview =
    mode === "DEPOSIT" && fund.sharePrice > 0 ? parsedUsdc / fund.sharePrice : 0

  const myUsdcValue = investor.shares * fund.sharePrice
  const needsApproval = mode === "DEPOSIT" && parsedUsdc > investor.allowance
  const canInstant =
    mode === "WITHDRAW" && parsedUsdc <= fund.instantLiquidity && fund.instantLiquidity > 0

  const depositTooLow = mode === "DEPOSIT" && parsedUsdc > 0 && parsedUsdc < MIN_AMOUNT
  const withdrawTooLow = mode === "WITHDRAW" && parsedUsdc > 0 && parsedUsdc < MIN_AMOUNT
  const insufficientUsdc = mode === "DEPOSIT" && parsedUsdc > investor.usdcBalance
  const insufficientShares =
    mode === "WITHDRAW" && sharesForWithdraw > investor.shares

  const isProcessing =
    approve.isPending || (approve.isConfirming && !approve.error) ||
    deposit.isPending || (deposit.isConfirming && !deposit.error) ||
    withdraw.isPending || (withdraw.isConfirming && !withdraw.error) ||
    instant.isPending || (instant.isConfirming && !instant.error)

  const isAmountInvalid =
    parsedUsdc <= 0 ||
    depositTooLow ||
    withdrawTooLow ||
    insufficientUsdc ||
    insufficientShares ||
    fund.paused

  const isSubmitDisabled = isConnected && (isAmountInvalid || isProcessing)

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
    if (!isConnected) {
      const connector = connectors[0]
      if (connector) connect({ connector, chainId: hyperliquidChain.id })
      return
    }
    if (isAmountInvalid || isProcessing) return
    if (mode === "DEPOSIT") {
      if (needsApproval) {
        approve.approve(parsedUsdc)
      } else {
        deposit.deposit(parsedUsdc)
      }
    } else {
      // WITHDRAW: convert USDC → shares, never let it exceed user's balance
      const shares = Math.min(sharesForWithdraw, investor.shares)
      if (useInstant && canInstant) {
        instant.instantWithdraw(shares)
      } else {
        withdraw.withdraw(shares)
      }
    }
  }, [
    isConnected, mode, parsedUsdc, sharesForWithdraw, needsApproval,
    useInstant, canInstant, isAmountInvalid, isProcessing, connectors,
  ])

  const activeError = deposit.error || withdraw.error || instant.error || approve.error
  const activeSuccess = deposit.isSuccess || withdraw.isSuccess || instant.isSuccess
  const activeHash = deposit.hash || withdraw.hash || instant.hash

  const buttonLabel = (() => {
    if (!isConnected) return "[ CONNECT WALLET ]"
    if (approve.isPending) return "[ APPROVING — CONFIRM IN WALLET ]"
    if (approve.isConfirming) return "[ CONFIRMING APPROVAL... ]"
    if (deposit.isPending) return "[ DEPOSIT — CONFIRM IN WALLET ]"
    if (deposit.isConfirming) return "[ CONFIRMING DEPOSIT... ]"
    if (withdraw.isPending) return "[ WITHDRAW — CONFIRM IN WALLET ]"
    if (withdraw.isConfirming) return "[ CONFIRMING WITHDRAWAL... ]"
    if (instant.isPending) return "[ INSTANT — CONFIRM IN WALLET ]"
    if (instant.isConfirming) return "[ CONFIRMING INSTANT WITHDRAW... ]"
    if (mode === "DEPOSIT") {
      if (needsApproval) return "[ APPROVE USDC ]"
      if (justApproved) return "[ ✓ APPROVED — DEPOSIT NOW ]"
      return "[ DEPOSIT ]"
    }
    return useInstant && canInstant ? "[ INSTANT WITHDRAW ]" : "[ QUEUE WITHDRAWAL ]"
  })()

  return (
    <div className="terminal-border-hero p-3 sm:p-4">
      {/* Mode tabs */}
      <div className="flex gap-1" role="tablist">
        {(["DEPOSIT", "WITHDRAW"] as Mode[]).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={mode === m}
            onClick={() => { setMode(m); setAmount(""); deposit.reset(); withdraw.reset(); instant.reset(); approve.reset() }}
            className={`flex-1 py-2.5 text-sm font-semibold tracking-wider transition-all ${
              mode === m
                ? "terminal-button bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-primary border border-transparent hover:border-primary/30"
            }`}
          >
            [{m}]
          </button>
        ))}
      </div>

      {/* Balance row */}
      <div className="flex justify-between items-center mt-3 text-xs">
        {mode === "DEPOSIT" ? (
          <>
            <span className="text-[color:var(--terminal-green-dim)]">
              USDC_BAL:{" "}
              {isConnected ? (
                <span className="text-[color:var(--terminal-green)] font-semibold">
                  {formatUsd(investor.usdcBalance)}
                </span>
              ) : (
                <span className="text-[color:var(--terminal-green-dim)]">— connect to view</span>
              )}
            </span>
            <span className="flex items-center gap-3">
              <BridgeLink />
              {isConnected && investor.usdcBalance > 0 && (
                <button
                  onClick={() => setAmount(String(investor.usdcBalance))}
                  className="text-[color:var(--terminal-cyan-dim)] hover:text-[color:var(--terminal-cyan)] transition-colors text-xs"
                >
                  [MAX]
                </button>
              )}
            </span>
          </>
        ) : (
          <>
            <span className="text-[color:var(--terminal-green-dim)]">
              MY_BALANCE:{" "}
              {isConnected ? (
                <span className="text-[color:var(--terminal-green)] font-semibold">
                  {formatUsd(myUsdcValue)}
                </span>
              ) : (
                <span className="text-[color:var(--terminal-green-dim)]">— connect to view</span>
              )}
            </span>
            {isConnected && investor.shares > 0 && (
              <button
                onClick={() => setAmount(myUsdcValue.toFixed(2))}
                className="text-[color:var(--terminal-cyan-dim)] hover:text-[color:var(--terminal-cyan)] transition-colors text-xs"
              >
                [MAX]
              </button>
            )}
          </>
        )}
      </div>

      {/* Bridge nudge for connected users with no USDC */}
      {mode === "DEPOSIT" && isConnected && investor.usdcBalance === 0 && (
        <div className="mt-1.5 text-xs text-[color:var(--terminal-amber-dim)]">
          ! USDC on HyperEVM required — bridge via link above
        </div>
      )}

      {/* Instant-liquidity awareness — surfaced upfront, not after typing */}
      {mode === "WITHDRAW" && (
        <div className="mt-1.5 text-xs text-[color:var(--terminal-cyan-dim)]">
          INSTANT_LIQ_AVAILABLE:{" "}
          <span className="text-[color:var(--terminal-cyan)]">
            {formatUsd(fund.instantLiquidity)}
          </span>
          <span className="ml-2">
            (above this, withdrawals queue to next settlement)
          </span>
        </div>
      )}

      {/* Input — always USDC */}
      <div className="mt-2 terminal-border-inset p-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[color:var(--terminal-green)] text-base">{">"}</span>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="flex-1 bg-transparent text-base text-[color:var(--terminal-green)] placeholder:text-[color:var(--terminal-green-dim)] outline-none font-mono"
            min={0}
            step="any"
          />
          <span className="text-sm text-[color:var(--terminal-green-dim)]">USDC</span>
        </div>
        <div className="mt-1 text-xs pl-5 flex items-center justify-between">
          <span className="text-[color:var(--terminal-cyan-dim)]">
            {parsedUsdc > 0
              ? mode === "DEPOSIT"
                ? `≈ ${formatShares(sharesForDepositPreview)} V4FUND shares`
                : `≈ ${formatShares(sharesForWithdraw)} V4FUND shares burned`
              : `MIN: ${MIN_AMOUNT} USDC`}
          </span>
        </div>
      </div>

      {/* Validation messages */}
      {depositTooLow && (
        <div className="mt-2 text-xs text-[color:var(--terminal-amber)]">
          ! MIN_DEPOSIT: {MIN_AMOUNT} USDC
        </div>
      )}
      {withdrawTooLow && (
        <div className="mt-2 text-xs text-[color:var(--terminal-amber)]">
          ! MIN_WITHDRAW: {MIN_AMOUNT} USDC
        </div>
      )}
      {insufficientUsdc && (
        <div className="mt-2 text-xs text-destructive">
          ! INSUFFICIENT_USDC — <BridgeLink />
        </div>
      )}
      {insufficientShares && (
        <div className="mt-2 text-xs text-destructive">
          ! AMOUNT_EXCEEDS_BALANCE — max {formatUsd(myUsdcValue)}
        </div>
      )}
      {fund.paused && (
        <div className="mt-2 text-xs text-[color:var(--terminal-amber)] glow-text-amber">
          ! CONTRACT_PAUSED — DEPOSITS AND WITHDRAWALS DISABLED
        </div>
      )}

      {/* Withdrawal mode toggle — opt-out, not opt-in */}
      {mode === "WITHDRAW" && parsedUsdc > 0 && canInstant && (
        <label className="mt-2 flex items-center gap-2 cursor-pointer text-xs">
          <input
            type="checkbox"
            checked={useInstant}
            onChange={(e) => setUseInstant(e.target.checked)}
            className="accent-[var(--terminal-green)]"
          />
          <span className="text-[color:var(--terminal-green)]">USE_INSTANT_WITHDRAW</span>
          <span className="text-[color:var(--terminal-green-dim)]">(skip 3PM CET queue)</span>
        </label>
      )}

      {/* 2-step approval hint */}
      {mode === "DEPOSIT" && parsedUsdc > 0 && needsApproval && !isProcessing && (
        <div className="mt-2 text-xs text-[color:var(--terminal-cyan-dim)]">
          ⓘ First deposit needs 2 signatures: approve USDC + deposit
        </div>
      )}

      {/* Settlement context — surfaced right above the CTA so the user sees it before clicking */}
      {parsedUsdc > 0 && !isAmountInvalid && (
        <div className="mt-3 text-xs text-[color:var(--terminal-green-dim)]">
          {mode === "DEPOSIT" ? (
            <>
              {">"} Receive ≈ <span className="text-[color:var(--terminal-green)]">
                {formatShares(sharesForDepositPreview)}
              </span>{" "}
              shares at next 3PM CET settlement (<SettlementCountdown inline />)
            </>
          ) : useInstant && canInstant ? (
            <>
              {">"} Withdraw <span className="text-[color:var(--terminal-green)]">
                {formatUsd(parsedUsdc)}
              </span>{" "}
              USDC immediately
            </>
          ) : (
            <>
              {">"} Receive ≈ <span className="text-[color:var(--terminal-green)]">
                {formatUsd(parsedUsdc)}
              </span>{" "}
              USDC at next 3PM CET settlement (<SettlementCountdown inline />)
            </>
          )}
        </div>
      )}

      {/* Submit button */}
      <button
        onClick={handleSubmit}
        disabled={isSubmitDisabled}
        className={`w-full mt-3 py-3 text-sm font-bold tracking-wider transition-all ${
          isSubmitDisabled
            ? "terminal-button-locked"
            : justApproved && !needsApproval
              ? "terminal-button animate-[deposit-pulse_0.8s_ease-in-out_infinite] shadow-[0_0_12px_var(--terminal-green)]"
              : "terminal-button"
        }`}
      >
        {buttonLabel}
      </button>

      {/* Status messages */}
      {activeError && (
        <div className="mt-2 text-xs text-destructive truncate">
          ERR: {(activeError as Error).message?.slice(0, 100)}
        </div>
      )}
      {activeSuccess && (
        <div className="mt-2 text-xs text-[color:var(--terminal-green-bright)] flex items-center gap-2 flex-wrap">
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

      {/* Footer settlement reminder (only when no input — keeps the panel anchored) */}
      {parsedUsdc <= 0 && (
        <div className="mt-3 pt-2 border-t border-border/50 text-xs text-muted-foreground">
          NEXT_SETTLEMENT: 3PM CET (<SettlementCountdown inline />)
        </div>
      )}
    </div>
  )
}

function SettlementCountdown({ inline = false }: { inline?: boolean }) {
  const [timeLeft, setTimeLeft] = useState("")

  useEffect(() => {
    const update = () => {
      const now = new Date()
      const utcHour = now.getUTCHours()
      const utcMin = now.getUTCMinutes()
      const targetHour = 14 // 3PM CET ≈ 14:00 UTC
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

  if (inline) return <span>{timeLeft || "—"}</span>
  return <span>NEXT_SETTLEMENT: 3PM CET{timeLeft ? ` (in ${timeLeft})` : ""}</span>
}

function BridgeLink() {
  return (
    <a
      href="https://jumper.exchange/?toChain=999&toToken=0xb88339CB7199b77E23DB6E890353E22632Ba630f"
      target="_blank"
      rel="noopener noreferrer"
      className="text-[color:var(--terminal-cyan)] hover:underline text-xs"
    >
      [BRIDGE USDC ↗]
    </a>
  )
}

function formatUsd(value: number) {
  return `$${value.toFixed(2)}`
}

function formatShares(value: number) {
  return value.toFixed(2)
}
