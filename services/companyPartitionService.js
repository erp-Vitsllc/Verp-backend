import Company from "../models/Company.js";
import CompanyCompliance from "../models/CompanyCompliance.js";
import CompanyOwners from "../models/CompanyOwners.js";
import CompanyDocumentBundle from "../models/CompanyDocumentBundle.js";
import CompanyWorkflow from "../models/CompanyWorkflow.js";

/** Heavy fields excluded from company list reads (MongoDB projection — exclusion only). */
export const COMPANY_LIST_SELECT = {
    owners: 0,
    oldOwners: 0,
    oldDocuments: 0,
    insurance: 0,
    ejari: 0,
    trainingDetails: 0,
    activationWorkflow: 0,
    activationHold: 0,
    pendingNotRenewRequests: 0,
    "pendingReactivationChanges.previousData": 0,
};

const COMPLIANCE_KEYS = [
    "tradeLicenseNumber",
    "tradeLicenseIssueDate",
    "tradeLicenseExpiry",
    "tradeLicenseOwnerName",
    "tradeLicenseAttachment",
    "establishmentCardNumber",
    "establishmentCardIssueDate",
    "establishmentCardExpiry",
    "establishmentCardAttachment",
];

const OWNER_KEYS = ["owners", "oldOwners"];
const DOCUMENT_BUNDLE_KEYS = ["documents", "insurance", "ejari", "trainingDetails", "oldDocuments", "customTabs"];
const WORKFLOW_KEYS = [
    "activationWorkflow",
    "pendingReactivationChanges",
    "activationHold",
    "pendingNotRenewRequests",
];

export function documentBundleHasLiveMoa(documents = []) {
    const docs = Array.isArray(documents) ? documents : [];
    return docs.some((d) => {
        if (!d || typeof d !== "object") return false;
        const t = String(d?.type || "").toLowerCase();
        const desc = String(d?.description || "").toLowerCase();
        if (t.includes("previous") || desc.includes("not renewed") || d?.archivedAt) return false;
        const url = d?.document?.url;
        if (!url || String(url).trim() === "") return false;
        const ctx = String(d?.context || "").toLowerCase();
        if (ctx === "moa") return true;
        return t.includes("moa");
    });
}

function stripMeta(row = {}) {
    const { company, _id, createdAt, updatedAt, __v, ...rest } = row;
    return rest;
}

export function mergePartitionedCompany(core, compliance, owners, bundle, workflow) {
    const merged = { ...core };
    if (compliance) Object.assign(merged, stripMeta(compliance));
    if (owners) Object.assign(merged, stripMeta(owners));
    if (bundle) {
        const b = stripMeta(bundle);
        Object.assign(merged, b);
        if (bundle.hasLiveMoa === true && !Array.isArray(merged.documents)) {
            merged.documents = [{ context: "moa", document: { url: "partitioned-moa-flag" } }];
        }
    }
    if (workflow) Object.assign(merged, stripMeta(workflow));
    return merged;
}

function partitionSlicesPresent(slices = {}) {
    return !!(slices.compliance || slices.owners || slices.bundle || slices.workflow);
}

export async function loadPartitionSlices(companyMongoId) {
    const id = String(companyMongoId);
    const [compliance, owners, bundle, workflow] = await Promise.all([
        CompanyCompliance.findOne({ company: id }).lean().maxTimeMS(8000),
        CompanyOwners.findOne({ company: id }).lean().maxTimeMS(8000),
        CompanyDocumentBundle.findOne({ company: id }).lean().maxTimeMS(8000),
        CompanyWorkflow.findOne({ company: id }).lean().maxTimeMS(8000),
    ]);
    return { compliance, owners, bundle, workflow };
}

/**
 * Full profile for detail page — partitioned companies load side collections in parallel.
 */
export async function loadCompanyFullProfile(coreDoc) {
    if (!coreDoc) return null;
    const core =
        typeof coreDoc.toObject === "function"
            ? coreDoc.toObject({ strict: false, virtuals: false })
            : { ...coreDoc };
    const slices = await loadPartitionSlices(core._id);
    if (Number(core.dataPartitionVersion) >= 1 || partitionSlicesPresent(slices)) {
        return mergePartitionedCompany(core, slices.compliance, slices.owners, slices.bundle, slices.workflow);
    }
    // Legacy monolith row: heavy fields may still exist only on `companies` in MongoDB
    return core;
}

/**
 * List row: core only; for partitioned rows attach compliance + hasLiveMoa for activation progress.
 */
export async function enrichCompaniesForList(companies = []) {
    const partitioned = companies.filter((c) => Number(c.dataPartitionVersion) >= 1);
    if (!partitioned.length) return companies;

    const ids = partitioned.map((c) => c._id);
    const [complianceRows, bundles, workflowRows] = await Promise.all([
        CompanyCompliance.find({ company: { $in: ids } })
            .select({
                company: 1,
                tradeLicenseNumber: 1,
                tradeLicenseIssueDate: 1,
                tradeLicenseExpiry: 1,
                tradeLicenseAttachment: 1,
                establishmentCardNumber: 1,
                establishmentCardIssueDate: 1,
                establishmentCardExpiry: 1,
                establishmentCardAttachment: 1,
            })
            .lean()
            .maxTimeMS(8000),
        CompanyDocumentBundle.find({ company: { $in: ids } })
            .select({ company: 1, hasLiveMoa: 1 })
            .lean()
            .maxTimeMS(8000),
        CompanyWorkflow.find({ company: { $in: ids } })
            .select({ company: 1, pendingReactivationChanges: 1 })
            .lean()
            .maxTimeMS(8000),
    ]);

    const complianceByCompany = new Map(complianceRows.map((r) => [String(r.company), r]));
    const bundleByCompany = new Map(bundles.map((r) => [String(r.company), r]));
    const workflowByCompany = new Map(workflowRows.map((r) => [String(r.company), r]));

    return companies.map((c) => {
        if (Number(c.dataPartitionVersion) < 1) return c;
        const id = String(c._id);
        const compliance = complianceByCompany.get(id);
        const bundle = bundleByCompany.get(id);
        const workflow = workflowByCompany.get(id);
        const merged = { ...c };
        if (compliance) Object.assign(merged, stripMeta(compliance));
        if (workflow?.pendingReactivationChanges) {
            merged.pendingReactivationChanges = workflow.pendingReactivationChanges.map((entry) => {
                if (!entry || typeof entry !== "object") return entry;
                const { previousData, ...rest } = entry;
                return rest;
            });
        }
        if (bundle?.hasLiveMoa) {
            merged.documents = [{ context: "moa", document: { url: "partitioned-moa-flag" } }];
        }
        return merged;
    });
}

export function pickCompliancePayload(company = {}) {
    const out = {};
    for (const k of COMPLIANCE_KEYS) {
        if (company[k] !== undefined) out[k] = company[k];
    }
    return out;
}

export function pickOwnersPayload(company = {}) {
    const out = {};
    for (const k of OWNER_KEYS) {
        if (company[k] !== undefined) out[k] = company[k];
    }
    return out;
}

export function pickDocumentBundlePayload(company = {}) {
    const out = {};
    for (const k of DOCUMENT_BUNDLE_KEYS) {
        if (company[k] !== undefined) out[k] = company[k];
    }
    if (out.documents !== undefined) {
        out.hasLiveMoa = documentBundleHasLiveMoa(out.documents);
    }
    return out;
}

export function pickWorkflowPayload(company = {}) {
    const out = {};
    for (const k of WORKFLOW_KEYS) {
        if (company[k] !== undefined) out[k] = company[k];
    }
    return out;
}

/** Upsert side collections after a company save (dual-write during migration). */
export async function upsertCompanyPartitions(companyMongoId, companyPayload = {}) {
    const id = companyMongoId;
    const compliance = pickCompliancePayload(companyPayload);
    const owners = pickOwnersPayload(companyPayload);
    const bundle = pickDocumentBundlePayload(companyPayload);
    const workflow = pickWorkflowPayload(companyPayload);

    await Promise.all([
        Object.keys(compliance).length
            ? CompanyCompliance.findOneAndUpdate(
                  { company: id },
                  { $set: { company: id, ...compliance } },
                  { upsert: true, new: true },
              )
            : Promise.resolve(),
        Object.keys(owners).length
            ? CompanyOwners.findOneAndUpdate(
                  { company: id },
                  { $set: { company: id, owners: owners.owners ?? [], oldOwners: owners.oldOwners ?? [] } },
                  { upsert: true, new: true },
              )
            : Promise.resolve(),
        Object.keys(bundle).length
            ? CompanyDocumentBundle.findOneAndUpdate(
                  { company: id },
                  { $set: { company: id, ...bundle } },
                  { upsert: true, new: true },
              )
            : Promise.resolve(),
        Object.keys(workflow).length
            ? CompanyWorkflow.findOneAndUpdate(
                  { company: id },
                  { $set: { company: id, ...workflow } },
                  { upsert: true, new: true },
              )
            : Promise.resolve(),
    ]);
}
