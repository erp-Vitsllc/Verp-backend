import Company from "../models/Company.js";
import CompanyOwners from "../models/CompanyOwners.js";
import { mergeCompanyOwnersSnapshot, OWNER_NESTED_DOC_KEYS } from "./mergeCompanyOwnersSnapshot.js";
import { normalizeOwnerProfileId } from "./ownerProfileId.js";

const SYNC_OWNER_SCALAR_KEYS = ["name", "email", "phone", "phoneCountryCode", "nationality"];

function ownerNestedDocHasContent(doc) {
    if (!doc || typeof doc !== "object") return false;
    const scalarKeys = ["number", "nationality", "type", "provider", "issueDate", "expiryDate"];
    if (scalarKeys.some((k) => doc[k] != null && String(doc[k]).trim() !== "")) return true;
    const att = doc.attachment;
    if (!att) return false;
    if (typeof att === "string") return String(att).trim() !== "";
    return Boolean(att?.url || att?.publicId || att?.data);
}

function ownerInfoScore(owner) {
    if (!owner) return 0;
    let score = 0;
    const scalarFields = ["email", "phone", "nationality"];
    for (const field of scalarFields) {
        if (owner[field] != null && String(owner[field]).trim() !== "") score += 3;
    }
    for (const key of OWNER_NESTED_DOC_KEYS) {
        if (ownerNestedDocHasContent(owner[key])) score += 8;
    }
    if (owner.attachment && String(owner.attachment).trim()) score += 4;
    return score;
}

function cloneJson(value) {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return value;
    }
}

/** Strip company-specific Mongo id; keep nested owner documents for cross-company reuse. */
export function buildOwnerCatalogRow(owner, profileId) {
    const row = cloneJson(owner || {});
    delete row._id;
    delete row.id;
    delete row.fromCompany;
    delete row.isExisting;
    delete row.isNew;
    row.ownerProfileId = profileId;
    row.name = String(owner?.name || "").trim();
    return row;
}

/**
 * Best owner row per ownerProfileId across all companies (richest passport / EID / visa data wins).
 * @returns {Promise<Map<string, { owner: object, fromCompany: string, score: number }>>}
 */
export async function loadGlobalOwnersCatalogMap() {
    const companies = await Company.find({}, { name: 1, companyId: 1, owners: 1, dataPartitionVersion: 1 })
        .lean()
        .maxTimeMS(10000);
    const companyMap = new Map(companies.map((c) => [String(c._id), c]));

    const ownerPartitions = await CompanyOwners.find({ "owners.0": { $exists: true } })
        .select({ company: 1, owners: 1 })
        .lean()
        .maxTimeMS(10000);

    const byProfileId = new Map();

    const consider = (owner, comp) => {
        const name = owner?.name != null ? String(owner.name).trim() : "";
        if (!name) return;
        const profileId = normalizeOwnerProfileId(owner?.ownerProfileId);
        if (!profileId) return;

        const companyName = comp?.name || comp?.companyId || "Unknown";
        const score = ownerInfoScore(owner);
        const prev = byProfileId.get(profileId);
        if (!prev || score > prev.score) {
            byProfileId.set(profileId, {
                owner: buildOwnerCatalogRow(owner, profileId),
                fromCompany: companyName,
                score,
            });
        }
    };

    for (const row of ownerPartitions) {
        const comp = companyMap.get(String(row.company));
        for (const owner of row.owners || []) {
            consider(owner, comp);
        }
    }

    for (const comp of companies) {
        if (Number(comp.dataPartitionVersion) >= 1) continue;
        for (const owner of comp.owners || []) {
            consider(owner, comp);
        }
    }

    return byProfileId;
}

/** Fill missing passport / EID / visa / etc. from the global catalog when linking an existing owner. */
export function enrichOwnerRowFromCatalog(owner, catalogEntry) {
    if (!owner || typeof owner !== "object" || !catalogEntry?.owner) return owner;
    const best = catalogEntry.owner;
    const out = { ...owner };

    for (const key of ["email", "phone", "phoneCountryCode", "nationality"]) {
        const current = out[key];
        const fromBest = best[key];
        if ((current == null || String(current).trim() === "") && fromBest != null && String(fromBest).trim() !== "") {
            out[key] = fromBest;
        }
    }

    for (const docKey of OWNER_NESTED_DOC_KEYS) {
        if (ownerNestedDocHasContent(out[docKey])) continue;
        if (!ownerNestedDocHasContent(best[docKey])) continue;
        out[docKey] = cloneJson(best[docKey]);
    }

    if (!out.attachment && best.attachment) {
        out.attachment = best.attachment;
    }

    return out;
}

export async function enrichOwnersFromGlobalCatalog(owners = []) {
    if (!Array.isArray(owners) || owners.length === 0) return owners;
    const catalog = await loadGlobalOwnersCatalogMap();
    return owners.map((owner) => {
        const profileId = normalizeOwnerProfileId(owner?.ownerProfileId);
        if (!profileId) return owner;
        const entry = catalog.get(profileId);
        if (!entry) return owner;
        return enrichOwnerRowFromCatalog(owner, entry);
    });
}

/** Copy shared owner profile fields; keep company-specific _id and share %. */
export function applySharedOwnerFieldsToRow(target = {}, source = {}) {
    if (!source || typeof source !== "object") return target;
    const out = target && typeof target === "object" ? { ...target } : {};
    for (const key of SYNC_OWNER_SCALAR_KEYS) {
        if (source[key] !== undefined) out[key] = source[key];
    }
    for (const docKey of OWNER_NESTED_DOC_KEYS) {
        if (!ownerNestedDocHasContent(source[docKey])) continue;
        out[docKey] = cloneJson(source[docKey]);
    }
    if (source.attachment) out.attachment = source.attachment;
    const profileId = normalizeOwnerProfileId(source.ownerProfileId);
    if (profileId) out.ownerProfileId = profileId;
    return out;
}

/** Collapse duplicate owner tabs in one company (same ownerProfileId, else same name). */
export function dedupeCompanyOwnersList(owners = []) {
    const result = [];
    const profileIndex = new Map();
    const nameIndex = new Map();

    for (const raw of owners) {
        if (!raw || typeof raw !== "object") continue;
        const profileId = normalizeOwnerProfileId(raw.ownerProfileId);
        const nameKey = String(raw.name || "").trim().toLowerCase();

        let targetIdx = -1;
        if (profileId && profileIndex.has(profileId)) {
            targetIdx = profileIndex.get(profileId);
        } else if (!profileId && nameKey && nameIndex.has(nameKey)) {
            targetIdx = nameIndex.get(nameKey);
        }

        if (targetIdx >= 0) {
            result[targetIdx] = mergeCompanyOwnersSnapshot([result[targetIdx]], [raw])[0];
            const mergedPid = normalizeOwnerProfileId(result[targetIdx].ownerProfileId);
            if (mergedPid && !profileIndex.has(mergedPid)) {
                profileIndex.set(mergedPid, targetIdx);
            }
            continue;
        }

        targetIdx = result.length;
        result.push({ ...raw });
        if (profileId) profileIndex.set(profileId, targetIdx);
        else if (nameKey) nameIndex.set(nameKey, targetIdx);
    }

    return result;
}

export function collectOwnerProfileIdsFromOwnerRows(owners = []) {
    const ids = new Set();
    for (const owner of owners) {
        const profileId = normalizeOwnerProfileId(owner?.ownerProfileId);
        if (profileId) ids.add(profileId);
    }
    return ids;
}

/** True when the same ownerProfileId exists on any other activated (status Active) company. */
export async function ownerProfileLinkedToActivatedCompany(profileId, excludeCompanyId = null) {
    const pid = normalizeOwnerProfileId(profileId);
    if (!pid) return false;

    const activeCompanies = await Company.find({ status: { $regex: /^active$/i } })
        .select("_id")
        .lean()
        .maxTimeMS(8000);
    const activeIds = new Set(
        activeCompanies
            .filter((c) => !excludeCompanyId || String(c._id) !== String(excludeCompanyId))
            .map((c) => String(c._id)),
    );
    if (!activeIds.size) return false;

    const partitions = await CompanyOwners.find({ "owners.ownerProfileId": pid })
        .select("company owners")
        .lean()
        .maxTimeMS(8000);

    for (const part of partitions) {
        if (!activeIds.has(String(part.company))) continue;
        const hit = (part.owners || []).some(
            (o) => normalizeOwnerProfileId(o?.ownerProfileId) === pid,
        );
        if (hit) return true;
    }
    return false;
}

/** Inactive company cannot edit owners that also exist on an activated company profile. */
export async function assertOwnersEditableFromCompany(companyCore, ownerProfileIds = []) {
    const status = String(companyCore?.status || "").toLowerCase();
    if (status === "active") return { ok: true };

    const ids = [...new Set((ownerProfileIds || []).map(normalizeOwnerProfileId).filter(Boolean))];
    for (const pid of ids) {
        const linked = await ownerProfileLinkedToActivatedCompany(pid, companyCore?._id);
        if (linked) {
            return {
                ok: false,
                message:
                    `Owner ${pid} is linked to an activated company. Open that active company profile to edit, renew, or delete this owner.`,
            };
        }
    }
    return { ok: true };
}

/** Push owner profile changes to every other company that shares the same ownerProfileId. */
export async function propagateOwnerProfilesAcrossCompanies(
    changedOwners = [],
    sourceCompanyId,
) {
    if (!sourceCompanyId || !Array.isArray(changedOwners) || changedOwners.length === 0) return;

    const byProfileId = new Map();
    for (const owner of changedOwners) {
        const profileId = normalizeOwnerProfileId(owner?.ownerProfileId);
        if (!profileId) continue;
        byProfileId.set(profileId, owner);
    }
    if (!byProfileId.size) return;

    const partitions = await CompanyOwners.find({})
        .select("company owners")
        .lean()
        .maxTimeMS(15000);

    const updates = [];
    for (const part of partitions) {
        if (String(part.company) === String(sourceCompanyId)) continue;
        let touched = false;
        const nextOwners = (part.owners || []).map((owner) => {
            const profileId = normalizeOwnerProfileId(owner?.ownerProfileId);
            if (!profileId || !byProfileId.has(profileId)) return owner;
            touched = true;
            return applySharedOwnerFieldsToRow(owner, byProfileId.get(profileId));
        });
        if (touched) {
            updates.push(
                CompanyOwners.updateOne({ company: part.company }, { $set: { owners: nextOwners } }),
            );
        }
    }

    if (updates.length) {
        await Promise.all(updates);
    }
}
