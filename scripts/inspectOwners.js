import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import Company from "../models/Company.js";
import CompanyOwners from "../models/CompanyOwners.js";

async function main() {
    await connectDB();

    console.log("=== COMPLIANCE PARTITIONS (CompanyOwners) ===");
    const partitions = await CompanyOwners.find({}).lean();
    for (const p of partitions) {
        console.log(`Partition ID: ${p._id}, Company: ${p.company}`);
        console.log(`- Owners (${(p.owners || []).length}):`, JSON.stringify(p.owners, null, 2));
        console.log(`- Old Owners (${(p.oldOwners || []).length}):`, JSON.stringify(p.oldOwners, null, 2));
    }

    console.log("\n=== LEGACY COMPANIES ===");
    const companies = await Company.find({}).lean();
    for (const c of companies) {
        console.log(`Company ID: ${c._id}, Name: ${c.name}, dataPartitionVersion: ${c.dataPartitionVersion}`);
        console.log(`- Owners (${(c.owners || []).length}):`, JSON.stringify(c.owners, null, 2));
    }

    await mongoose.connection.close();
}

main().catch(console.error);
