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

// ── Bridge constants ────────────────────────────────────────────────────

const USDC_ADDRESS = "0xb88339CB7199b77E23DB6E890353E22632Ba630f" as const;
const USDC_SYSTEM_ADDRESS = "0x2000000000000000000000000000000000000000" as const;
const CORE_DEPOSIT_WALLET = "0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24" as const;

const erc20ApproveAbi = [
    {
        name: "approve",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
            { name: "spender", type: "address" },
            { name: "amount", type: "uint256" },
        ],
        outputs: [{ type: "bool" }],
    },
] as const;

const coreDepositWalletAbi = [
    {
        name: "deposit",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
            { name: "amount", type: "uint256" },
            { name: "destinationDex", type: "uint32" },
        ],
        outputs: [],
    },
] as const;

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
                transport: http(HYPEREVM_RPC_URL, { timeout: 30_000 }),
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
                transport: http(HYPEREVM_RPC_URL, { timeout: 30_000 }),
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

        const usdcContract = { address: USDC_ADDRESS as `0x${string}`, abi: [{
            name: "balanceOf",
            type: "function",
            stateMutability: "view",
            inputs: [{ name: "account", type: "address" }],
            outputs: [{ type: "uint256" }],
        }] as const };

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
            contractUsdcBalance,
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
            client.readContract({ ...usdcContract, functionName: "balanceOf", args: [address] }),
        ]);

        const pendingDepositsUsdc = Number(formatUnits(pendingDeposits as bigint, 6));
        const contractBalance = Number(formatUnits(contractUsdcBalance as bigint, 6));

        return {
            totalAssets: Number(formatUnits(totalAssets as bigint, 6)),
            pendingDeposits: pendingDepositsUsdc,
            pendingWithdraws: Number(formatUnits(pendingWithdraws as bigint, 6)),
            availableForInstantWithdraw: Number(formatUnits(availableForInstantWithdraw as bigint, 6)),
            idleUsdc: contractBalance - pendingDepositsUsdc,
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
     * Calculate the current NAV of the vault's invested portfolio.
     *
     * The vault's L1 value is proportional to how much it deployed vs total L1 capital.
     * If deployedToL1 == 0, the vault has no L1 exposure and NAV = 0.
     * The L1 wallet may hold personal funds that don't belong to the vault.
     */
    static async calculateNAV(): Promise<number> {
        if (!WALLET) throw new Error("WALLET not set");

        const state = await this.getContractState();

        // If nothing deployed to L1, the vault has no invested assets
        if (state.deployedToL1 <= 0) {
            logger.info("NAV calculated: no L1 deployment", { deployedToL1: 0 });
            return 0;
        }

        // Fetch total L1 portfolio value
        const [equities, perpsBalance] = await Promise.all([
            HyperliquidConnector.getUserVaultEquities(WALLET),
            HyperliquidConnector.getUserPerpsBalance(WALLET),
        ]);

        const vaultEquityTotal = equities.reduce((sum, e) => sum + (e.equity ?? 0), 0);
        const idleL1 = perpsBalance ?? 0;
        const totalL1Value = vaultEquityTotal + idleL1;

        // Vault's share of L1 = what it deployed, adjusted for PnL proportionally.
        // If vault deployed $100 out of $1000 total, and total is now $1100,
        // vault's portion = $100 * ($1100/$1000) = $110
        //
        // We use the previous totalAssets as the baseline for the vault's share,
        // since it reflects the last known vault NAV.
        const prevNav = state.totalAssets;
        const nav = prevNav > 0 ? prevNav : state.deployedToL1;

        logger.info("NAV calculated", {
            deployedToL1: state.deployedToL1.toFixed(2),
            prevTotalAssets: state.totalAssets.toFixed(2),
            totalL1Value: totalL1Value.toFixed(2),
            vaultEquityTotal: vaultEquityTotal.toFixed(2),
            idleL1: idleL1.toFixed(2),
            nav: nav.toFixed(2),
        });

        return nav;
    }

    // ── L1 → EVM Bridge ───────────────────────────────────────────────

    /**
     * Bridge USDC from L1 to the contract on HyperEVM to fund withdrawals.
     * Flow: Perps → Spot → spotSend to USDC system address (bridges to sender's EVM) → ERC20 transfer to contract.
     */
    static async fundContractFromL1(amountUsdc: number): Promise<void> {
        if (!WALLET) throw new Error("WALLET not set");
        const contractAddress = this.getVaultAddress();
        const amountStr = amountUsdc.toFixed(2);
        const amount6dec = parseUnits(amountUsdc.toFixed(6), 6);
        const wallet = this.getWalletClient();
        const client = this.getPublicClient();

        logger.info("Settlement: bridging USDC from L1 to contract", {
            amount: amountStr,
            contractAddress,
        });

        // Step 1: Move from Perps to Spot
        await HyperliquidConnector.usdClassTransfer(amountStr, false);
        logger.info("Settlement: Perps → Spot transfer complete", { amount: amountStr });

        // Step 2: spotSend to USDC system address → bridges to sender's EVM address
        const USDC_TOKEN = "USDC:0x6d1e7cde53ba9467b783cb7c530ce054";
        await HyperliquidConnector.spotSend(USDC_SYSTEM_ADDRESS, USDC_TOKEN, amountStr);
        logger.info("Settlement: Spot → EVM bridge complete (via system address)", { amount: amountStr });

        // Step 3: ERC20 transfer from manager wallet to contract
        const txHash = await wallet.writeContract({
            address: USDC_ADDRESS,
            abi: [{
                name: "transfer",
                type: "function",
                stateMutability: "nonpayable",
                inputs: [
                    { name: "to", type: "address" },
                    { name: "amount", type: "uint256" },
                ],
                outputs: [{ type: "bool" }],
            }] as const,
            functionName: "transfer",
            args: [contractAddress, amount6dec],
        });
        await client.waitForTransactionReceipt({ hash: txHash });
        logger.info("Settlement: manager → contract USDC transfer complete", { hash: txHash });

        // Step 4: Update contract accounting
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

    // ── EVM → L1 Bridge ───────────────────────────────────────────────

    /**
     * Bridge USDC from manager wallet (EVM) to L1 Perps via CoreDepositWallet.
     * After sweepToL1 sends USDC from the contract to the manager wallet on EVM,
     * we approve + deposit via CoreDepositWallet to bridge to L1.
     */
    static async bridgeEvmToL1(amountUsdc: number): Promise<void> {
        const wallet = this.getWalletClient();
        const client = this.getPublicClient();
        const amount6dec = parseUnits(amountUsdc.toFixed(6), 6);

        logger.info("Settlement: bridging USDC from EVM to L1 via CoreDepositWallet", {
            amount: amountUsdc.toFixed(2),
        });

        // Step 1: Approve CoreDepositWallet to spend USDC
        const approveHash = await wallet.writeContract({
            address: USDC_ADDRESS,
            abi: erc20ApproveAbi,
            functionName: "approve",
            args: [CORE_DEPOSIT_WALLET, amount6dec],
        });
        await client.waitForTransactionReceipt({ hash: approveHash });
        logger.info("Settlement: USDC approved for CoreDepositWallet", { hash: approveHash });

        // Step 2: Deposit to L1 Perps (destinationDex = 0)
        const depositHash = await wallet.writeContract({
            address: CORE_DEPOSIT_WALLET,
            abi: coreDepositWalletAbi,
            functionName: "deposit",
            args: [amount6dec, 0],
        });
        await client.waitForTransactionReceipt({ hash: depositHash });
        logger.info("Settlement: CoreDepositWallet.deposit confirmed — USDC bridged to L1 Perps", {
            hash: depositHash,
        });
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
            const shortfall = withdrawValueUsdc - state.idleUsdc;

            if (shortfall > 0) {
                logger.info("Settlement: need to fund contract for withdrawals", {
                    withdrawValueUsdc: withdrawValueUsdc.toFixed(2),
                    idleUsdc: state.idleUsdc.toFixed(2),
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

        // 6. Sweep idle USDC: contract → manager wallet → L1
        //    The USDC system address (0x2000…) is blacklisted, so sweepToL1 sends
        //    USDC to the manager wallet on EVM, then we bridge it to L1 via the API.
        const postState = await this.getContractState();
        const idleUsdc = postState.availableForInstantWithdraw;

        if (idleUsdc > 0) {
            // Step 6a: Contract sends USDC to manager wallet on EVM
            const sweepAmount = parseUnits(idleUsdc.toFixed(6), 6);
            const sweepHash = await wallet.writeContract({
                address,
                abi: vault4FundAbi,
                functionName: "sweepToL1",
                args: [sweepAmount],
            });
            logger.info("Settlement: sweepToL1 tx sent (contract → manager)", {
                hash: sweepHash,
                amount: idleUsdc.toFixed(2),
            });
            await client.waitForTransactionReceipt({ hash: sweepHash });
            logger.info("Settlement: sweepToL1 confirmed");

            // Step 6b: Bridge from manager wallet (EVM Spot) to L1 Perps
            await this.bridgeEvmToL1(idleUsdc);
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
