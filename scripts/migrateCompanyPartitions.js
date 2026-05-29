/**
 * Split heavy company fields into side collections for faster list loads.
 *
 * Usage (from VERP_backend):
 *   node scripts/migrateCompanyPartitions.js
 *   node scripts/migrateCompanyPartitions.js --strip-monolith   # also $unset heavy fields on companies
 *
 * Collections (same MongoDB database as today):
 *   companies              — core identity + status
 *   companycompliances     — trade license + establishment card
 *   companyowners          — owners + oldOwners
 *   companydocumentbundles — documents, insurance, ejari, training, oldDocuments
 *   companyworkflows       — activation workflow, holds, not-renew queue
 *
 * Files stay on IDrive/S3; only URL strings move between collections.
 */

import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import Company from "../models/Company.js";
import CompanyCompliance from "../models/CompanyCompliance.js";
import CompanyOwners from "../models/CompanyOwners.js";
import CompanyDocumentBundle from "../models/CompanyDocumentBundle.js";
import CompanyWorkflow from "../models/CompanyWorkflow.js";
import {
    pickCompliancePayload,
    pickOwnersPayload,
    pickDocumentBundlePayload,
    pickWorkflowPayload,
} from "../services/companyPartitionService.js";

const STRIP_MONOLITH = process.argv.includes("--strip-monolith");

const MONOLITH_UNSET = {
    tradeLicenseNumber: "",
    tradeLicenseIssueDate: "",
    tradeLicenseExpiry: "",
    tradeLicenseOwnerName: "",
    tradeLicenseAttachment: "",
    establishmentCardNumber: "",
    establishmentCardIssueDate: "",
    establishmentCardExpiry: "",
    establishmentCardAttachment: "",
    owners: "",
    oldOwners: "",
    documents: "",
    insurance: "",
    ejari: "",
    trainingDetails: "",
    oldDocuments: "",
    customTabs: "",
    activationWorkflow: "",
    pendingReactivationChanges: "",
    activationHold: "",
    pendingNotRenewRequests: "",
};

async function migrateOne(company) {
    const id = company._id;
    const compliance = pickCompliancePayload(company);
    const owners = pickOwnersPayload(company);
    const bundle = pickDocumentBundlePayload(company);
    const workflow = pickWorkflowPayload(company);

    await Promise.all([
        CompanyCompliance.findOneAndUpdate(
            { company: id },
            { $set: { company: id, ...compliance } },
            { upsert: true },
        ),
        CompanyOwners.findOneAndUpdate(
            { company: id },
            {
                $set: {
                    company: id,
                    owners: owners.owners ?? company.owners ?? [],
                    oldOwners: owners.oldOwners ?? company.oldOwners ?? [],
                },
            },
            { upsert: true },
        ),
        CompanyDocumentBundle.findOneAndUpdate(
            { company: id },
            { $set: { company: id, ...bundle } },
            { upsert: true },
        ),
        CompanyWorkflow.findOneAndUpdate(
            { company: id },
            { $set: { company: id, ...workflow } },
            { upsert: true },
        ),
    ]);

    const update = { $set: { dataPartitionVersion: 1 } };
    if (STRIP_MONOLITH) {
        update.$unset = MONOLITH_UNSET;
    }
    await Company.updateOne({ _id: id }, update);
}

async function main() {
    await connectDB();
    const cursor = Company.find({}).cursor();
    let n = 0;
    for await (const company of cursor) {
        await migrateOne(company.toObject());
        n += 1;
        if (n % 25 === 0) console.log(`Migrated ${n} companies…`);
    }
    console.log(`Done. Migrated ${n} companies. stripMonolith=${STRIP_MONOLITH}`);
    await mongoose.connection.close();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
