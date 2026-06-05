import Company from "../models/Company.js";
import CompanyOwners from "../models/CompanyOwners.js";
import { OWNER_NESTED_DOC_KEYS } from "./mergeCompanyOwnersSnapshot.js";
import { normalizeOwnerProfileId } from "./ownerProfileId.js";

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
