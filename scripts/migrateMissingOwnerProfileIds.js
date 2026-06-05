import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import Company from "../models/Company.js";
import CompanyOwners from "../models/CompanyOwners.js";
import {
    normalizeOwnerProfileId,
    generateOwnerProfileId,
    collectGlobalOwnerProfileIds
} from "../utils/ownerProfileId.js";

async function main() {
    console.log("Connecting to database...");
    await connectDB();

    console.log("Collecting globally used Owner Profile IDs...");
    const usedIds = await collectGlobalOwnerProfileIds();
    console.log(`Currently used unique IDs: ${usedIds.size} (${Array.from(usedIds).join(", ")})`);

    // 1. Process partitioned CompanyOwners
    console.log("\nChecking partitioned CompanyOwners collection...");
    const partitions = await CompanyOwners.find({});
    let partitionsModified = 0;
    let partitionsOwnerCount = 0;

    for (const partition of partitions) {
        let modified = false;
        if (partition.owners && Array.isArray(partition.owners)) {
            for (const owner of partition.owners) {
                const normalized = normalizeOwnerProfileId(owner.ownerProfileId);
                if (!normalized) {
                    const newId = generateOwnerProfileId(usedIds);
                    console.log(`Partition Company ID ${partition.company}: Assigning ID ${newId} to owner "${owner.name}" (was: ${owner.ownerProfileId})`);
                    owner.ownerProfileId = newId;
                    usedIds.add(newId);
                    modified = true;
                    partitionsOwnerCount++;
                }
            }
        }
        if (partition.oldOwners && Array.isArray(partition.oldOwners)) {
            for (const owner of partition.oldOwners) {
                const normalized = normalizeOwnerProfileId(owner.ownerProfileId);
                if (!normalized) {
                    const newId = generateOwnerProfileId(usedIds);
                    console.log(`Partition Company ID ${partition.company} (oldOwners): Assigning ID ${newId} to owner "${owner.name}" (was: ${owner.ownerProfileId})`);
                    owner.ownerProfileId = newId;
                    usedIds.add(newId);
                    modified = true;
                    partitionsOwnerCount++;
                }
            }
        }

        if (modified) {
            partition.markModified("owners");
            partition.markModified("oldOwners");
            await partition.save();
            partitionsModified++;
        }
    }
    console.log(`Done. Updated ${partitionsOwnerCount} owners across ${partitionsModified} partitioned company owner documents.`);

    // 2. Process legacy Company documents (just in case they have owners and aren't partitioned, or for completeness)
    console.log("\nChecking legacy Company documents...");
    const companies = await Company.find({});
    let companiesModified = 0;
    let companiesOwnerCount = 0;

    for (const comp of companies) {
        let modified = false;
        if (comp.owners && Array.isArray(comp.owners)) {
            for (const owner of comp.owners) {
                const normalized = normalizeOwnerProfileId(owner.ownerProfileId);
                if (!normalized) {
                    const newId = generateOwnerProfileId(usedIds);
                    console.log(`Legacy Company "${comp.name}": Assigning ID ${newId} to owner "${owner.name}" (was: ${owner.ownerProfileId})`);
                    owner.ownerProfileId = newId;
                    usedIds.add(newId);
                    modified = true;
                    companiesOwnerCount++;
                }
            }
        }
        if (comp.oldOwners && Array.isArray(comp.oldOwners)) {
            for (const owner of comp.oldOwners) {
                const normalized = normalizeOwnerProfileId(owner.ownerProfileId);
                if (!normalized) {
                    const newId = generateOwnerProfileId(usedIds);
                    console.log(`Legacy Company "${comp.name}" (oldOwners): Assigning ID ${newId} to owner "${owner.name}" (was: ${owner.ownerProfileId})`);
                    owner.ownerProfileId = newId;
                    usedIds.add(newId);
                    modified = true;
                    companiesOwnerCount++;
                }
            }
        }

        if (modified) {
            comp.markModified("owners");
            comp.markModified("oldOwners");
            await comp.save();
            companiesModified++;
        }
    }
    console.log(`Done. Updated ${companiesOwnerCount} owners across ${companiesModified} legacy company documents.`);

    console.log("\nMigration completed successfully!");
    await mongoose.connection.close();
}

main().catch((err) => {
    console.error("Migration error:", err);
    process.exit(1);
});
