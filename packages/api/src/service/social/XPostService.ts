import { TwitterApi } from "twitter-api-v2";
import { logger } from "../utils/logger";

const X_API_KEY = process.env.X_API_KEY;
const X_API_SECRET = process.env.X_API_SECRET;
const X_ACCESS_TOKEN = process.env.X_ACCESS_TOKEN;
const X_ACCESS_SECRET = process.env.X_ACCESS_SECRET;

interface SettlementStats {
    epoch: number;
    totalAssets: number;
    sharePrice: number;
    deployedToL1: number;
    depositsProcessed: number;
    withdrawsProcessed: number;
}

export class XPostService {
    private static client: TwitterApi | null = null;

    private static getClient(): TwitterApi | null {
        if (this.client) return this.client;
        if (!X_API_KEY || !X_API_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_SECRET) {
            return null;
        }
        this.client = new TwitterApi({
            appKey: X_API_KEY,
            appSecret: X_API_SECRET,
            accessToken: X_ACCESS_TOKEN,
            accessSecret: X_ACCESS_SECRET,
        });
        return this.client;
    }

    static isConfigured(): boolean {
        return !!(X_API_KEY && X_API_SECRET && X_ACCESS_TOKEN && X_ACCESS_SECRET);
    }

    static async postSettlementUpdate(stats: SettlementStats): Promise<void> {
        const client = this.getClient();
        if (!client) {
            logger.info("X posting skipped: API keys not configured");
            return;
        }

        const text = [
            `VAULT-4 | Settlement Report`,
            ``,
            `Epoch: ${stats.epoch}`,
            `TVL: $${stats.totalAssets.toFixed(2)}`,
            `Share Price: ${stats.sharePrice.toFixed(6)}`,
            `Deployed to L1: $${stats.deployedToL1.toFixed(2)}`,
            stats.depositsProcessed > 0 ? `Deposits processed: ${stats.depositsProcessed}` : null,
            stats.withdrawsProcessed > 0 ? `Withdrawals processed: ${stats.withdrawsProcessed}` : null,
            ``,
            `Next settlement: 3PM CET`,
            `vault-4.xyz`,
        ]
            .filter(Boolean)
            .join("\n");

        try {
            const result = await client.v2.tweet(text);
            logger.info("X post published", { tweetId: result.data.id });
        } catch (error: any) {
            logger.warn("X post failed", { message: error?.message });
        }
    }
}
