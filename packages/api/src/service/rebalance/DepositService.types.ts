export type DepositTarget = {
    vaultAddress: `0x${string}`;
    name: string;
    confidence: "high" | "low";
    kind: "new" | "topup";
    targetPct: number;
    targetUsd: number;
    currentUsd: number;
    desiredUsd: number;
    depositUsd: number;
};
