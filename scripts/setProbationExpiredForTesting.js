/**
 * One-off dev/testing: force an employee into "probation expired" state so the UI shows
 * "Start Permanent Request" / HOD probation buttons (frontend uses contractJoiningDate + probationPeriod).
 *
 * Usage (from VERP_backend, with .env containing MONGO_URI):
 *   node scripts/setProbationExpiredForTesting.js <employeeId>
 *   node scripts/setProbationExpiredForTesting.js <employeeId> --reset
 *
 * --reset  clears probationChangeRequest so you can run the flow from scratch.
 */

import dotenv from "dotenv";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import EmployeeBasic from "../models/EmployeeBasic.js";

dotenv.config({ path: ".env" });

const cliArgs = process.argv.slice(2);
const resetWorkflow = cliArgs.includes("--reset");
const employeeId = cliArgs.find((a) => a !== "--reset" && !a.startsWith("--"));

async function main() {
    if (!employeeId || String(employeeId).trim() === "") {
        console.error('Usage: node scripts/setProbationExpiredForTesting.js <employeeId> [--reset]\nExample: node scripts/setProbationExpiredForTesting.js VEGA-HR-0001 --reset');
        process.exit(1);
    }

    await connectDB();

    const emp = await EmployeeBasic.findOne({ employeeId: String(employeeId).trim() });
    if (!emp) {
        console.error(`No employee found with employeeId="${employeeId}"`);
        await mongoose.connection.close().catch(() => {});
        process.exit(1);
    }

    const months = Number(emp.probationPeriod) >= 1 ? Math.floor(Number(emp.probationPeriod)) : 6;

    const join = new Date();
    join.setHours(12, 0, 0, 0);
    join.setMonth(join.getMonth() - (months + 2));

    await EmployeeBasic.findByIdAndUpdate(emp._id, {
        $set: {
            status: "Probation",
            probationPeriod: months,
            contractJoiningDate: join,
        },
        ...(resetWorkflow ? { $unset: { probationChangeRequest: "" } } : {}),
    });

    const endPreview = new Date(join);
    endPreview.setMonth(endPreview.getMonth() + months);

    console.log(`Updated ${employeeId}:`);
    console.log(`  status: Probation`);
    console.log(`  probationPeriod (months): ${months}`);
    console.log(`  contractJoiningDate: ${join.toISOString().slice(0, 10)}`);
    console.log(`  implied probation end: ${endPreview.toISOString().slice(0, 10)}`);
    console.log(resetWorkflow ? "  probationChangeRequest: cleared" : "  probationChangeRequest: left as-is");

    await mongoose.connection.close().catch(() => {});
    process.exit(0);
}

main().catch((err) => {
    console.error(err);
    mongoose.connection.close().catch(() => {});
    process.exit(1);
});
