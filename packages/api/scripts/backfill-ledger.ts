import "dotenv/config";
import { runMigrations } from "../src/db/migrate";
import { TraceService } from "../src/db/TraceService";

async function main() {
    await runMigrations();
    const inserted = await TraceService.syncLedger();
    console.log(JSON.stringify({ inserted }, null, 2));
    process.exit(0);
}

main().catch((err) => {
    console.error("backfill-ledger failed:", err);
    process.exit(1);
});
