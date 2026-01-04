import OpenAI from "openai";
import { logger } from "../utils/logger";
import type { VaultCandidate } from "../vaults/types";

type OpenAIRankedVault = {
    vaultAddress: string;
    reason?: string;
    score?: number;
};

export type OpenAIRanking = {
    model: string;
    highConfidence: OpenAIRankedVault[];
    lowConfidence: OpenAIRankedVault[];
    raw: string;
};

const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.2-thinking";
const RAW_TEMPERATURE = Number(process.env.OPENAI_TEMPERATURE ?? 0.2);
const DEFAULT_TEMPERATURE = Number.isFinite(RAW_TEMPERATURE) ? RAW_TEMPERATURE : 0.2;
const RAW_MAX_CANDIDATES = Number(process.env.OPENAI_MAX_CANDIDATES ?? 80);
const MAX_CANDIDATES = Number.isFinite(RAW_MAX_CANDIDATES) ? RAW_MAX_CANDIDATES : 80;

export class OpenAIService {
    private static client: OpenAI | null = null;

    static isConfigured(): boolean {
        return Boolean(process.env.OPENAI_API_KEY);
    }

    static async rankVaults(
        candidates: VaultCandidate[],
        totalCount: number,
        highConfidenceCount: number
    ): Promise<OpenAIRanking | null> {
        if (!this.isConfigured()) {
            logger.warn("OpenAI API key missing, skipping AI ranking");
            return null;
        }
        if (!candidates.length) return null;

        const client = this.getClient();
        const trimmed = candidates.slice(0, MAX_CANDIDATES).map((candidate) => ({
            vaultAddress: candidate.vaultAddress,
            name: candidate.name,
            tvl: candidate.tvl,
            ageDays: candidate.ageDays,
            weeklyPnl: candidate.weeklyPnl,
            monthlyPnl: candidate.monthlyPnl,
            allTimePnl: candidate.allTimePnl,
            followers: candidate.followers,
            tradesLast7d: candidate.tradesLast7d,
            allowDeposits: candidate.allowDeposits,
        }));

        const systemPrompt =
            "You are a quantitative analyst ranking Hyperliquid vaults. " +
            "Return strict JSON only with keys: high_confidence, low_confidence. " +
            "Each array must contain objects with vaultAddress, reason, score (0-100). " +
            "Total length must equal the requested total count. " +
            "High confidence count must match the requested count. " +
            "Only select from the provided candidates and do not duplicate vaults.";

        const userPrompt = JSON.stringify({
            request: {
                totalCount,
                highConfidenceCount,
                lowConfidenceCount: Math.max(totalCount - highConfidenceCount, 0),
            },
            candidates: trimmed,
        });

        try {
            const response = await client.chat.completions.create({
                model: DEFAULT_MODEL,
                temperature: DEFAULT_TEMPERATURE,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt },
                ],
            });

            const content = response.choices?.[0]?.message?.content?.trim() ?? "";
            const parsed = parseJsonPayload(content);
            if (!parsed) {
                logger.warn("OpenAI response was not valid JSON");
                return null;
            }

            const high = Array.isArray(parsed.high_confidence)
                ? parsed.high_confidence
                : parsed.highConfidence;
            const low = Array.isArray(parsed.low_confidence)
                ? parsed.low_confidence
                : parsed.lowConfidence;

            if (!Array.isArray(high) || !Array.isArray(low)) {
                logger.warn("OpenAI response missing confidence arrays");
                return null;
            }

            return {
                model: DEFAULT_MODEL,
                highConfidence: normalizeRankedVaults(high),
                lowConfidence: normalizeRankedVaults(low),
                raw: content,
            };
        } catch (error: any) {
            logger.warn("OpenAI ranking failed", { message: error?.message });
            return null;
        }
    }

    private static getClient(): OpenAI {
        if (!this.client) {
            this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        }
        return this.client;
    }
}

function normalizeRankedVaults(entries: any[]): OpenAIRankedVault[] {
    return entries
        .map((entry) => ({
            vaultAddress: String(entry.vaultAddress ?? "").trim(),
            reason: entry.reason ? String(entry.reason).trim() : undefined,
            score: Number.isFinite(Number(entry.score)) ? Number(entry.score) : undefined,
        }))
        .filter((entry) => Boolean(entry.vaultAddress));
}

function parseJsonPayload(content: string): any | null {
    if (!content) return null;
    try {
        return JSON.parse(content);
    } catch {
        const start = content.indexOf("{");
        const end = content.lastIndexOf("}");
        if (start === -1 || end === -1 || end <= start) return null;
        try {
            return JSON.parse(content.slice(start, end + 1));
        } catch {
            return null;
        }
    }
}
