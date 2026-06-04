import mongoose from "mongoose";
import Company from "../models/Company.js";
import CompanyCompliance from "../models/CompanyCompliance.js";
import CompanyOwners from "../models/CompanyOwners.js";
import CompanyDocumentBundle from "../models/CompanyDocumentBundle.js";
import CompanyWorkflow from "../models/CompanyWorkflow.js";
import { ownerDocUnsetPath } from "../utils/companyOwnerDocDeletion.js";
import { archiveSupersededCompanyDocuments } from "../utils/archiveCompanyDocument.js";
import { archiveSupersededCompanyOwners } from "../utils/archiveCompanyOwners.js";

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
export const DOCUMENT_BUNDLE_KEYS = ["documents", "insurance", "ejari", "trainingDetails", "oldDocuments", "customTabs"];
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

/** Partitioned compliance is authoritative — do not keep legacy fields from `companies` core. */
function applyCompliancePartition(merged, compliance) {
    const usePartition =
        Number(merged.dataPartitionVersion) >= 1 || compliance != null;
    if (!usePartition) return;
    const slice = compliance ? stripMeta(compliance) : {};
    for (const k of COMPLIANCE_KEYS) {
        delete merged[k];
    }
    Object.assign(merged, slice);
}

/** Partitioned owners are authoritative — do not keep legacy owner arrays on `companies` core. */
function applyOwnersPartition(merged, owners) {
    const usePartition = Number(merged.dataPartitionVersion) >= 1 || owners != null;
    if (!usePartition) return;
    const slice = owners ? stripMeta(owners) : {};
    for (const k of OWNER_KEYS) {
        delete merged[k];
    }
    if (!Array.isArray(slice.owners)) slice.owners = [];
    if (!Array.isArray(slice.oldOwners)) slice.oldOwners = [];
    Object.assign(merged, slice);
}

/** Partitioned document bundle is authoritative — never fall back to legacy `companies` arrays. */
function applyBundlePartition(merged, bundle) {
    const usePartition = Number(merged.dataPartitionVersion) >= 1 || bundle != null;
    if (!usePartition) return;
    const slice = bundle ? stripMeta(bundle) : {};
    for (const k of DOCUMENT_BUNDLE_KEYS) {
        delete merged[k];
    }
    for (const k of DOCUMENT_BUNDLE_KEYS) {
        if (!Array.isArray(slice[k])) slice[k] = [];
    }
    if (bundle?.hasLiveMoa === true && !documentBundleHasLiveMoa(slice.documents)) {
        slice.documents = [{ context: "moa", document: { url: "partitioned-moa-flag" } }];
    }
    Object.assign(merged, slice);
}

/** Workflow / pending queue lives only on `companyworkflows` for partitioned companies. */
function applyWorkflowPartition(merged, workflow) {
    const usePartition = Number(merged.dataPartitionVersion) >= 1 || workflow != null;
    if (!usePartition) return;
    const slice = workflow ? stripMeta(workflow) : {};
    for (const k of WORKFLOW_KEYS) {
        delete merged[k];
    }
    Object.assign(merged, slice);
}

export function mergePartitionedCompany(core, compliance, owners, bundle, workflow) {
    const merged = { ...core };
    applyCompliancePartition(merged, compliance);
    applyOwnersPartition(merged, owners);
    applyBundlePartition(merged, bundle);
    applyWorkflowPartition(merged, workflow);
    return merged;
}

export function isCompanyUsingPartitions(core = {}) {
    return Number(core.dataPartitionVersion) >= 1;
}

function partitionSliceHasValues(slice, keys, { arrayKeys = [] } = {}) {
    if (!slice) return false;
    for (const k of keys) {
        const v = slice[k];
        if (v !== undefined && v !== null && v !== "") return true;
    }
    for (const k of arrayKeys) {
        if (Array.isArray(slice[k]) && slice[k].length > 0) return true;
    }
    return false;
}

function legacyMonolithHasComplianceData(raw = {}) {
    return COMPLIANCE_KEYS.some((k) => {
        const v = raw[k];
        return v !== undefined && v !== null && v !== "";
    });
}

function legacyMonolithHasOwnersData(raw = {}) {
    return (
        (Array.isArray(raw.owners) && raw.owners.length > 0) ||
        (Array.isArray(raw.oldOwners) && raw.oldOwners.length > 0)
    );
}

function legacyMonolithHasWorkflowData(raw = {}) {
    return WORKFLOW_KEYS.some((k) => {
        const v = raw[k];
        if (Array.isArray(v)) return v.length > 0;
        return v !== undefined && v !== null;
    });
}

/**
 * One-time per read: if heavy fields still exist on `companies` but partition rows are empty,
 * copy into side collections and strip monolith so UI + deletes use only new collections.
 */
export async function reconcileLegacyMonolithIntoPartitions(core, slices = {}) {
    if (!isCompanyUsingPartitions(core)) return slices;

    const raw = await Company.collection.findOne({ _id: core._id });
    if (!raw) return slices;

    const id = core._id;
    let { compliance, owners, bundle, workflow } = slices;
    const unsetMonolith = {};

    if (legacyMonolithHasComplianceData(raw) && !partitionSliceHasValues(compliance, COMPLIANCE_KEYS)) {
        const payload = pickCompliancePayload(raw);
        compliance = await CompanyCompliance.findOneAndUpdate(
            { company: id },
            { $set: { company: id, ...payload } },
            { upsert: true, new: true },
        ).lean();
        for (const k of COMPLIANCE_KEYS) {
            if (raw[k] !== undefined) unsetMonolith[k] = "";
        }
    }

    if (legacyMonolithHasOwnersData(raw) && !partitionSliceHasValues(owners, [], { arrayKeys: OWNER_KEYS })) {
        const payload = pickOwnersPayload(raw);
        owners = await CompanyOwners.findOneAndUpdate(
            { company: id },
            {
                $set: {
                    company: id,
                    owners: payload.owners ?? raw.owners ?? [],
                    oldOwners: payload.oldOwners ?? raw.oldOwners ?? [],
                },
            },
            { upsert: true, new: true },
        ).lean();
        unsetMonolith.owners = "";
        unsetMonolith.oldOwners = "";
    }

    const bundleSet = { company: id };
    let bundleTouched = false;
    for (const k of DOCUMENT_BUNDLE_KEYS) {
        const legacyArr = Array.isArray(raw[k]) ? raw[k] : [];
        const partArr = Array.isArray(bundle?.[k]) ? bundle[k] : [];
        if (legacyArr.length > 0 && partArr.length === 0) {
            bundleSet[k] = legacyArr;
            unsetMonolith[k] = "";
            bundleTouched = true;
        }
    }
    if (bundleTouched) {
        if (bundleSet.documents) {
            bundleSet.hasLiveMoa = documentBundleHasLiveMoa(bundleSet.documents);
        } else if (bundle?.hasLiveMoa) {
            bundleSet.hasLiveMoa = bundle.hasLiveMoa;
        }
        bundle = await CompanyDocumentBundle.findOneAndUpdate(
            { company: id },
            { $set: bundleSet },
            { upsert: true, new: true },
        ).lean();
    }

    if (legacyMonolithHasWorkflowData(raw) && !partitionSliceHasValues(workflow, WORKFLOW_KEYS, { arrayKeys: WORKFLOW_KEYS })) {
        const payload = pickWorkflowPayload(raw);
        workflow = await CompanyWorkflow.findOneAndUpdate(
            { company: id },
            { $set: { company: id, ...payload } },
            { upsert: true, new: true },
        ).lean();
        for (const k of WORKFLOW_KEYS) {
            if (raw[k] !== undefined) unsetMonolith[k] = "";
        }
    }

    if (Object.keys(unsetMonolith).length) {
        await Company.collection.updateOne({ _id: id }, { $unset: unsetMonolith });
    }

    return { compliance, owners, bundle, workflow };
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
    let slices = await loadPartitionSlices(core._id);

    if (isCompanyUsingPartitions(core)) {
        slices = await reconcileLegacyMonolithIntoPartitions(core, slices);
        return mergePartitionedCompany(core, slices.compliance, slices.owners, slices.bundle, slices.workflow);
    }

    if (partitionSlicesPresent(slices)) {
        return mergePartitionedCompany(core, slices.compliance, slices.owners, slices.bundle, slices.workflow);
    }

    // Unmigrated monolith (dataPartitionVersion 0, no side collections)
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
        applyCompliancePartition(merged, compliance);
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

/** Fields stored in side collections — stripped from strict Company $set. */
export const PARTITION_UPDATE_KEYS = new Set([
    ...COMPLIANCE_KEYS,
    ...OWNER_KEYS,
    ...DOCUMENT_BUNDLE_KEYS,
    ...WORKFLOW_KEYS,
]);

export function splitCompanyUpdatePayload(payload = {}) {
    const coreUpdate = {};
    const partitionUpdate = {};
    for (const [key, value] of Object.entries(payload)) {
        if (PARTITION_UPDATE_KEYS.has(key)) {
            partitionUpdate[key] = value;
        } else {
            coreUpdate[key] = value;
        }
    }
    return { coreUpdate, partitionUpdate };
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

export const companyPendingEntryId = (entry, idx) => String(entry?._id ?? idx);

/** Pending queue + workflow fields live on CompanyWorkflow after partition migration. */
export async function persistCompanyPendingReactivationChanges(companyMongoId, pendingArray = []) {
    await upsertCompanyPartitions(companyMongoId, {
        pendingReactivationChanges: Array.isArray(pendingArray) ? pendingArray : [],
    });
}

export async function clearCompanyWorkflowActivationHold(companyMongoId) {
    await CompanyWorkflow.updateOne({ company: companyMongoId }, { $unset: { activationHold: 1 } });
}

/** Apply one HR-approved proposedData patch (compliance, owners, documents, core fields). */
export async function applyCompanyProposedActivationPatch(companyMongoId, proposedData) {
    if (!proposedData || typeof proposedData !== "object") {
        return { ownerArchivesToPush: [] };
    }
    const core = await Company.findById(companyMongoId).lean().maxTimeMS(8000);
    if (!core) return { ownerArchivesToPush: [] };
    const before = (await loadCompanyFullProfile(core)) || core;

    await archiveSupersededCompanyDocuments(before, proposedData);
    const ownerArchives = archiveSupersededCompanyOwners(before, proposedData) || [];

    const { coreUpdate, partitionUpdate } = splitCompanyUpdatePayload(proposedData);
    if (Object.keys(coreUpdate).length) {
        await Company.findByIdAndUpdate(companyMongoId, { $set: coreUpdate }).maxTimeMS(8000);
    }
    if (Object.keys(partitionUpdate).length) {
        await upsertCompanyPartitions(companyMongoId, partitionUpdate);
    }
    return { ownerArchivesToPush: ownerArchives };
}

/** Parse Mongo subdoc _id or array index from route `:target`. */
export function resolveSubdocPullTarget(target) {
    const targetStr = String(target ?? "").trim();
    if (/^[a-fA-F0-9]{24}$/.test(targetStr)) {
        return { pullById: true, oid: new mongoose.Types.ObjectId(targetStr), idStr: targetStr };
    }
    const index = Number.parseInt(targetStr, 10);
    if (Number.isInteger(index) && index >= 0) {
        return { pullById: false, index };
    }
    return null;
}

export function subdocRowId(row) {
    if (!row || typeof row !== "object") return "";
    const raw = row._id ?? row.id;
    return raw != null ? String(raw).trim() : "";
}

/** Find a row in one bundle array by Mongo subdoc _id/id or numeric index. */
export function findBundleArrayRow(list, target) {
    const items = Array.isArray(list) ? list : [];
    const resolved = resolveSubdocPullTarget(target);
    if (!resolved) return null;
    if (resolved.pullById) {
        return (
            items.find((row) => {
                const rowId = subdocRowId(row);
                return rowId && rowId === resolved.idStr;
            }) || null
        );
    }
    return items[resolved.index] || null;
}

/** Locate a document row in live and/or archived bundle arrays. */
export function findCompanyDocumentRow(profile = {}, target, fields = ["documents", "oldDocuments"]) {
    for (const field of fields) {
        const row = findBundleArrayRow(profile[field], target);
        if (row) return { field, row };
    }
    return null;
}

async function pullLegacyMonolithArray(companyId, field, resolved) {
    if (resolved.pullById) {
        const result = await Company.collection.updateOne(
            { _id: companyId },
            { $pull: { [field]: { _id: resolved.oid } } },
        );
        return {
            modified: result.modifiedCount > 0,
            matched: result.matchedCount > 0,
            found: result.modifiedCount > 0,
        };
    }

    const unsetResult = await Company.collection.updateOne(
        { _id: companyId },
        { $unset: { [`${field}.${resolved.index}`]: 1 } },
    );
    if (unsetResult.modifiedCount) {
        await Company.collection.updateOne({ _id: companyId }, { $pull: { [field]: null } });
    }
    return {
        modified: unsetResult.modifiedCount > 0,
        matched: unsetResult.matchedCount > 0,
        found: unsetResult.modifiedCount > 0,
    };
}

async function pullFromBundleDocument(bundle, field, resolved) {
    if (!bundle) return { modified: false, matched: false, found: false };
    if (!Array.isArray(bundle[field])) bundle[field] = [];

    const arr = bundle[field];
    let removed = false;

    if (resolved.pullById) {
        const before = arr.length;
        bundle[field] = arr.filter((row) => subdocRowId(row) !== resolved.idStr);
        removed = bundle[field].length < before;
    } else if (resolved.index < arr.length) {
        arr.splice(resolved.index, 1);
        removed = true;
    }

    if (!removed) {
        return { modified: false, matched: true, found: false };
    }

    if (field === "documents") {
        bundle.hasLiveMoa = documentBundleHasLiveMoa(bundle.documents);
    }
    await bundle.save();
    return { modified: true, matched: true, found: true };
}

/**
 * Remove one row from a document-bundle array (`documents`, `oldDocuments`, `ejari`, etc.).
 * Partitioned companies: `companydocumentbundles` only (never read legacy for display/delete target).
 */
export async function pullFromCompanyDocumentBundle(companyMongoId, field, target) {
    const resolved = resolveSubdocPullTarget(target);
    if (!resolved) {
        return { modified: false, matched: false, found: false };
    }

    const companyId =
        companyMongoId instanceof mongoose.Types.ObjectId
            ? companyMongoId
            : new mongoose.Types.ObjectId(String(companyMongoId));

    const core = await Company.findById(companyId).select("dataPartitionVersion").lean().maxTimeMS(8000);
    const partitioned = isCompanyUsingPartitions(core || {});

    let bundle = await CompanyDocumentBundle.findOne({ company: companyId });
    if (partitioned && !bundle) {
        bundle = await CompanyDocumentBundle.create({
            company: companyId,
            documents: [],
            oldDocuments: [],
            insurance: [],
            ejari: [],
            trainingDetails: [],
            customTabs: [],
            hasLiveMoa: false,
        });
    }

    if (bundle) {
        const fromBundle = await pullFromBundleDocument(bundle, field, resolved);
        if (fromBundle.found) return fromBundle;
        if (partitioned) {
            return { modified: false, matched: true, found: false };
        }
    }

    if (partitioned) {
        return { modified: false, matched: !!bundle, found: false };
    }

    return pullLegacyMonolithArray(companyId, field, resolved);
}

/** Bundle array for API logic — partition collection only when company is partitioned. */
export async function loadAuthoritativeBundleArray(companyMongoId, field) {
    const companyId =
        companyMongoId instanceof mongoose.Types.ObjectId
            ? companyMongoId
            : new mongoose.Types.ObjectId(String(companyMongoId));
    const core = await Company.findById(companyId).select("dataPartitionVersion").lean().maxTimeMS(8000);
    if (!isCompanyUsingPartitions(core || {})) {
        const full = await loadCompanyFullProfile(core);
        return Array.isArray(full?.[field]) ? full[field] : [];
    }
    const bundle = await CompanyDocumentBundle.findOne({ company: companyId }).lean().maxTimeMS(8000);
    return Array.isArray(bundle?.[field]) ? bundle[field] : [];
}

export function findOwnerRow(list, ownerId) {
    const idStr = String(ownerId ?? "").trim();
    if (!idStr) return null;
    return (Array.isArray(list) ? list : []).find((row) => subdocRowId(row) === idStr) || null;
}

/** Remove one nested owner document card (passport, visa, etc.) from companyowners partition. */
export async function clearOwnerDocInPartition(companyMongoId, ownerTarget, ownerId, docKey) {
    if (!["owners", "oldOwners"].includes(ownerTarget)) {
        return { modified: false, matched: false, found: false };
    }

    const ownerOid = new mongoose.Types.ObjectId(String(ownerId));
    const filterKey = ownerTarget === "oldOwners" ? "o" : "live";
    const unsetPath = ownerDocUnsetPath(ownerTarget, docKey);
    const companyId =
        companyMongoId instanceof mongoose.Types.ObjectId
            ? companyMongoId
            : new mongoose.Types.ObjectId(String(companyMongoId));

    const ownersPartition = await CompanyOwners.findOne({ company: companyId }).select("_id").lean();
    const updateFilter = ownersPartition ? { company: companyId } : { _id: companyId };
    const model = ownersPartition ? CompanyOwners : Company.collection;
    const result = await model.updateOne(
        updateFilter,
        { $unset: { [unsetPath]: 1 } },
        { arrayFilters: [{ [`${filterKey}._id`]: ownerOid }] },
    );

    return {
        modified: result.modifiedCount > 0,
        matched: result.matchedCount > 0,
        found: result.modifiedCount > 0,
    };
}

/** Pull an entire owner subdocument from owners or oldOwners. */
export async function pullOwnerFromPartition(companyMongoId, ownerTarget, target) {
    if (!["owners", "oldOwners"].includes(ownerTarget)) {
        return { modified: false, matched: false, found: false };
    }

    const resolved = resolveSubdocPullTarget(target);
    if (!resolved) {
        return { modified: false, matched: false, found: false };
    }

    const companyId =
        companyMongoId instanceof mongoose.Types.ObjectId
            ? companyMongoId
            : new mongoose.Types.ObjectId(String(companyMongoId));

    const ownersDoc = await CompanyOwners.findOne({ company: companyId });
    if (ownersDoc && Array.isArray(ownersDoc[ownerTarget])) {
        const arr = ownersDoc[ownerTarget];
        let removed = false;

        if (resolved.pullById) {
            const before = arr.length;
            ownersDoc[ownerTarget] = arr.filter((row) => subdocRowId(row) !== resolved.idStr);
            removed = ownersDoc[ownerTarget].length < before;
        } else if (resolved.index < arr.length) {
            arr.splice(resolved.index, 1);
            removed = true;
        }

        if (!removed) {
            return { modified: false, matched: true, found: false };
        }

        await ownersDoc.save();
        return { modified: true, matched: true, found: true };
    }

    if (resolved.pullById) {
        const result = await Company.collection.updateOne(
            { _id: companyId },
            { $pull: { [ownerTarget]: { _id: resolved.oid } } },
        );
        return {
            modified: result.modifiedCount > 0,
            matched: result.matchedCount > 0,
            found: result.modifiedCount > 0,
        };
    }

    const unsetResult = await Company.collection.updateOne(
        { _id: companyId },
        { $unset: { [`${ownerTarget}.${resolved.index}`]: 1 } },
    );
    if (unsetResult.modifiedCount) {
        await Company.collection.updateOne({ _id: companyId }, { $pull: { [ownerTarget]: null } });
    }
    return {
        modified: unsetResult.modifiedCount > 0,
        matched: unsetResult.matchedCount > 0,
        found: unsetResult.modifiedCount > 0,
    };
}
