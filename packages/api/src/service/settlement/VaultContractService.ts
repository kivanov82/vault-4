import {
    createPublicClient,
    createWalletClient,
    http,
    parseUnits,
    formatUnits,
    defineChain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { logger } from "../utils/logger";
import { HyperliquidConnector } from "../trade/HyperliquidConnector";

// ── Config ──────────────────────────────────────────────────────────────

const VAULT4FUND_ADDRESS = process.env.VAULT4FUND_ADDRESS as `0x${string}` | undefined;
const HYPEREVM_RPC_URL = process.env.HYPEREVM_RPC_URL ?? "https://rpc.hyperliquid.xyz/evm";
const WALLET_PK = process.env.WALLET_PK as `0x${string}` | undefined;
const WALLET = process.env.WALLET as `0x${string}` | undefined;

// HyperEVM chain definition
const hyperEvm = defineChain({
    id: 999,
    name: "HyperEVM",
    nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
    rpcUrls: { default: { http: [HYPEREVM_RPC_URL] } },
});

// ── Minimal ABI (only settlement functions) ─────────────────────────────

const vault4FundAbi = [
    // Manager write functions
    {
        name: "updateTotalAssets",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [{ name: "newTotalAssets", type: "uint256" }],
        outputs: [],
    },
    {
        name: "settle",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
            { name: "maxDeposits", type: "uint256" },
            { name: "maxWithdraws", type: "uint256" },
        ],
        outputs: [],
    },
    {
        name: "sweepToL1",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [{ name: "amount", type: "uint256" }],
        outputs: [],
    },
    {
        name: "recordL1Return",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [{ name: "amount", type: "uint256" }],
        outputs: [],
    },
    // View functions
    {
        name: "totalAssets",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        name: "pendingDeposits",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        name: "pendingWithdraws",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        name: "availableForInstantWithdraw",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        name: "depositQueueLength",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        name: "depositQueueHead",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        name: "withdrawQueueLength",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        name: "epoch",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        name: "sharePrice",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        name: "deployedToL1",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
] as const;

// ── Service ─────────────────────────────────────────────────────────────

export class VaultContractService {
    private static publicClient: any = null;
    private static walletClient: any = null;

    private static getPublicClient() {
        if (!this.publicClient) {
            this.publicClient = createPublicClient({
                chain: hyperEvm,
                transport: http(HYPEREVM_RPC_URL),
            });
        }
        return this.publicClient;
    }

    private static getWalletClient() {
        if (!this.walletClient) {
            if (!WALLET_PK) throw new Error("WALLET_PK not set");
            const account = privateKeyToAccount(WALLET_PK);
            this.walletClient = createWalletClient({
                account,
                chain: hyperEvm,
                transport: http(HYPEREVM_RPC_URL),
            });
        }
        return this.walletClient;
    }

    private static getVaultAddress(): `0x${string}` {
        if (!VAULT4FUND_ADDRESS) throw new Error("VAULT4FUND_ADDRESS not set");
        return VAULT4FUND_ADDRESS;
    }

    // ── Read helpers ────────────────────────────────────────────────────

    static async getContractState() {
        const client = this.getPublicClient();
        const address = this.getVaultAddress();
        const contract = { address, abi: vault4FundAbi } as const;

        const [
            totalAssets,
            pendingDeposits,
            pendingWithdraws,
            availableForInstantWithdraw,
            depositQueueLength,
            depositQueueHead,
            withdrawQueueLength,
            epoch,
            sharePrice,
            deployedToL1,
        ] = await Promise.all([
            client.readContract({ ...contract, functionName: "totalAssets" }),
            client.readContract({ ...contract, functionName: "pendingDeposits" }),
            client.readContract({ ...contract, functionName: "pendingWithdraws" }),
            client.readContract({ ...contract, functionName: "availableForInstantWithdraw" }),
            client.readContract({ ...contract, functionName: "depositQueueLength" }),
            client.readContract({ ...contract, functionName: "depositQueueHead" }),
            client.readContract({ ...contract, functionName: "withdrawQueueLength" }),
            client.readContract({ ...contract, functionName: "epoch" }),
            client.readContract({ ...contract, functionName: "sharePrice" }),
            client.readContract({ ...contract, functionName: "deployedToL1" }),
        ]);

        return {
            totalAssets: Number(formatUnits(totalAssets as bigint, 6)),
            pendingDeposits: Number(formatUnits(pendingDeposits as bigint, 6)),
            pendingWithdraws: Number(formatUnits(pendingWithdraws as bigint, 6)),
            availableForInstantWithdraw: Number(formatUnits(availableForInstantWithdraw as bigint, 6)),
            depositQueueLength: Number(depositQueueLength),
            depositQueueHead: Number(depositQueueHead),
            withdrawQueueLength: Number(withdrawQueueLength),
            epoch: Number(epoch),
            sharePrice: Number(formatUnits(sharePrice as bigint, 18)),
            deployedToL1: Number(formatUnits(deployedToL1 as bigint, 6)),
        };
    }

    // ── NAV Calculation ─────────────────────────────────────────────────

    /**
     * Calculate the current NAV of the invested portfolio (L1 vaults + idle L1 USDC).
     * This EXCLUDES pending deposits on the contract (they're not invested yet).
     */
    static async calculateNAV(): Promise<number> {
        if (!WALLET) throw new Error("WALLET not set");

        const [equities, perpsBalance] = await Promise.all([
            HyperliquidConnector.getUserVaultEquities(WALLET),
            HyperliquidConnector.getUserPerpsBalance(WALLET),
        ]);

        const vaultEquityTotal = equities.reduce((sum, e) => sum + (e.equity ?? 0), 0);
        const idleL1 = perpsBalance ?? 0;
        const nav = vaultEquityTotal + idleL1;

        logger.info("NAV calculated", {
            vaultEquityTotal: vaultEquityTotal.toFixed(2),
            idleL1: idleL1.toFixed(2),
            nav: nav.toFixed(2),
            vaultCount: equities.filter(e => e.equity > 1).length,
        });

        return nav;
    }

    // ── L1 → EVM Bridge ───────────────────────────────────────────────

    /**
     * Bridge USDC from L1 to the contract on HyperEVM to fund withdrawals.
     * Flow: Perps → Spot → spotSend to contract address.
     */
    static async fundContractFromL1(amountUsdc: number): Promise<void> {
        const contractAddress = this.getVaultAddress();
        const amountStr = amountUsdc.toFixed(2);

        logger.info("Settlement: bridging USDC from L1 to contract", {
            amount: amountStr,
            contractAddress,
        });

        // Step 1: Move from Perps to Spot
        await HyperliquidConnector.usdClassTransfer(amountStr, false);
        logger.info("Settlement: Perps → Spot transfer complete", { amount: amountStr });

        // Step 2: spotSend from Spot to contract on HyperEVM
        const USDC_TOKEN = "USDC:0xeb62eee3685fc4c43992febcd9e75443";
        await HyperliquidConnector.spotSend(contractAddress, USDC_TOKEN, amountStr);
        logger.info("Settlement: Spot → EVM contract transfer complete", {
            amount: amountStr,
            contractAddress,
        });

        // Step 3: Update contract accounting
        const amount6dec = parseUnits(amountUsdc.toFixed(6), 6);
        const wallet = this.getWalletClient();
        const client = this.getPublicClient();

        const hash = await wallet.writeContract({
            address: contractAddress,
            abi: vault4FundAbi,
            functionName: "recordL1Return",
            args: [amount6dec],
        });
        logger.info("Settlement: recordL1Return tx sent", { hash });
        await client.waitForTransactionReceipt({ hash });
        logger.info("Settlement: recordL1Return confirmed");
    }

    // ── Settlement Flow ─────────────────────────────────────────────────

    /**
     * Run the full settlement:
     *   1. Fund contract from L1 if needed for pending withdrawals
     *   2. updateTotalAssets (report current NAV)
     *   3. settle (process deposits + withdrawals)
     *   4. sweepToL1 (bridge idle USDC back to L1 for investing)
     */
    static async runSettlement(options: { dryRun?: boolean } = {}): Promise<void> {
        const dryRun = options.dryRun ?? false;
        const address = this.getVaultAddress();
        const wallet = this.getWalletClient();
        const client = this.getPublicClient();

        // 1. Read contract state
        const state = await this.getContractState();
        logger.info("Settlement: contract state", state);

        const hasPendingDeposits = state.depositQueueLength > state.depositQueueHead;
        const hasPendingWithdraws = state.pendingWithdraws > 0;

        if (!hasPendingDeposits && !hasPendingWithdraws) {
            logger.info("Settlement: nothing to settle, skipping");
            return;
        }

        // 2. Calculate NAV
        const nav = await this.calculateNAV();
        const navUsdc6dec = parseUnits(nav.toFixed(6), 6);

        logger.info("Settlement: NAV", {
            nav: nav.toFixed(2),
            navUsdc6dec: navUsdc6dec.toString(),
            dryRun,
        });

        if (dryRun) {
            logger.info("Settlement: dry run, stopping before writes");
            return;
        }

        // 3. If pending withdrawals, fund contract from L1
        if (hasPendingWithdraws) {
            const withdrawValueUsdc = state.pendingWithdraws * state.sharePrice;
            const contractIdle = state.availableForInstantWithdraw;
            const shortfall = withdrawValueUsdc - contractIdle;

            if (shortfall > 0) {
                logger.info("Settlement: need to fund contract for withdrawals", {
                    withdrawValueUsdc: withdrawValueUsdc.toFixed(2),
                    contractIdle: contractIdle.toFixed(2),
                    shortfall: shortfall.toFixed(2),
                });
                await this.fundContractFromL1(Math.ceil(shortfall * 100) / 100);
            }
        }

        // 4. updateTotalAssets
        const updateHash = await wallet.writeContract({
            address,
            abi: vault4FundAbi,
            functionName: "updateTotalAssets",
            args: [navUsdc6dec],
        });
        logger.info("Settlement: updateTotalAssets tx sent", { hash: updateHash });
        await client.waitForTransactionReceipt({ hash: updateHash });
        logger.info("Settlement: updateTotalAssets confirmed");

        // 5. settle
        const maxDeposits = BigInt(state.depositQueueLength - state.depositQueueHead);
        const maxWithdraws = BigInt(state.withdrawQueueLength);

        const settleHash = await wallet.writeContract({
            address,
            abi: vault4FundAbi,
            functionName: "settle",
            args: [maxDeposits, maxWithdraws],
        });
        logger.info("Settlement: settle tx sent", {
            hash: settleHash,
            maxDeposits: maxDeposits.toString(),
            maxWithdraws: maxWithdraws.toString(),
        });
        await client.waitForTransactionReceipt({ hash: settleHash });
        logger.info("Settlement: settle confirmed");

        // 6. Sweep all idle USDC to L1
        const postState = await this.getContractState();
        const idleUsdc = postState.availableForInstantWithdraw;

        if (idleUsdc > 0) {
            const sweepAmount = parseUnits(idleUsdc.toFixed(6), 6);
            const sweepHash = await wallet.writeContract({
                address,
                abi: vault4FundAbi,
                functionName: "sweepToL1",
                args: [sweepAmount],
            });
            logger.info("Settlement: sweepToL1 tx sent", {
                hash: sweepHash,
                amount: idleUsdc.toFixed(2),
            });
            await client.waitForTransactionReceipt({ hash: sweepHash });
            logger.info("Settlement: sweepToL1 confirmed");
        } else {
            logger.info("Settlement: no idle USDC to sweep");
        }

        // 7. Log final state
        const finalState = await this.getContractState();
        logger.info("Settlement: complete", {
            epoch: finalState.epoch,
            totalAssets: finalState.totalAssets.toFixed(2),
            sharePrice: finalState.sharePrice.toFixed(6),
            deployedToL1: finalState.deployedToL1.toFixed(2),
        });
    }
}
