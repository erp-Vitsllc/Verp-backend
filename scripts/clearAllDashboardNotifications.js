/**
 * Deletes every document in DashboardAction (dashboard + bell notification rows).
 *
 * Usage (from VERP_backend, with MONGO_URI in .env):
 *   node scripts/clearAllDashboardNotifications.js --confirm
 *
 * Optional: only pending rows:
 *   node scripts/clearAllDashboardNotifications.js --confirm --pending-only
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import DashboardAction from "../models/DashboardAction.js";

dotenv.config({ path: ".env" });

const confirm = process.argv.includes("--confirm");
const pendingOnly = process.argv.includes("--pending-only");

async function main() {
    if (!confirm) {
        console.error(
            "Refusing to run: this removes dashboard notification rows from DashboardAction.\n" +
                "Re-run with: node scripts/clearAllDashboardNotifications.js --confirm\n" +
                "Add --pending-only to delete only status=Pending rows."
        );
        process.exit(1);
    }

    await connectDB();

    const filter = pendingOnly ? { status: "Pending" } : {};
    const result = await DashboardAction.deleteMany(filter);

    console.log(
        `Done. Deleted ${result.deletedCount} DashboardAction document(s)` +
            (pendingOnly ? " (Pending only)." : " (entire collection).")
    );
}

main()
    .catch((err) => {
        console.error("Failed:", err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.connection.close().catch(() => {});
        process.exit(process.exitCode ?? 0);
    });
