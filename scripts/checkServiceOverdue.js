import dotenv from "dotenv";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import { processAssetServiceOverdue } from "../utils/processAssetServiceOverdue.js";

dotenv.config({ path: ".env" });

const run = async () => {
    try {
        await connectDB();
        const result = await processAssetServiceOverdue();
        console.log(
            `✅ Asset service check complete. Checked ${result.checked} assets. ` +
            `Expiry-day emails: ${result.expiryEmailCount}, expiry/overdue tasks: ${result.expiryTaskCount}.`,
        );
    } catch (error) {
        console.error("❌ Failed to check asset service overdue:", error);
    } finally {
        await mongoose.connection.close();
        process.exit(0);
    }
};

run();
