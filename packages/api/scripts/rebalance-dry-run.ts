import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.join(__dirname, "..", ".env.dev") });

import { RebalanceOrchestrator } from "../src/service/rebalance/RebalanceOrchestrator";

async function main() {
    const result = await RebalanceOrchestrator.runRound({
        dryRun: true,
        refreshCandidates: true,
        refreshRecommendations: true,
    });
    console.log("\n=== RESULT ===");
    console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
    console.error("Dry-run failed:", err);
    process.exit(1);
});
