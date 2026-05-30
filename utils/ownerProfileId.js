import CompanyOwners from "../models/CompanyOwners.js";

export const OWNER_PROFILE_ID_REGEX = /^\d{4}$/;

export function isValidOwnerProfileId(value) {
    return OWNER_PROFILE_ID_REGEX.test(String(value ?? "").trim());
}

export function normalizeOwnerProfileId(value) {
    const raw = String(value ?? "").trim();
    if (OWNER_PROFILE_ID_REGEX.test(raw)) return raw;
    if (/^\d{1,4}$/.test(raw)) {
        const padded = raw.padStart(4, "0");
        if (OWNER_PROFILE_ID_REGEX.test(padded)) return padded;
    }
    return "";
}

export function resolveOwnerProfileId(owner) {
    return normalizeOwnerProfileId(owner?.ownerProfileId);
}

export function generateOwnerProfileId(usedIds = new Set()) {
    for (let n = 1; n <= 9999; n += 1) {
        const id = String(n).padStart(4, "0");
        if (!usedIds.has(id)) return id;
    }
    throw new Error("No available owner IDs");
}

export async function collectGlobalOwnerProfileIds() {
    const rows = await CompanyOwners.find({}).select("owners oldOwners").lean();
    const ids = new Set();
    for (const row of rows) {
        for (const owner of [...(row.owners || []), ...(row.oldOwners || [])]) {
            const normalized = normalizeOwnerProfileId(owner?.ownerProfileId);
            if (normalized) ids.add(normalized);
        }
    }
    return ids;
}

export function assignOwnerProfileIds(owners = [], globalUsedIds = new Set()) {
    const payloadIds = new Set();
    return owners.map((owner) => {
        const row = owner && typeof owner === "object" ? { ...owner } : {};
        let id = normalizeOwnerProfileId(row.ownerProfileId);

        if (id) {
            if (payloadIds.has(id)) {
                throw new Error(`Duplicate Owner ID ${id} is not allowed`);
            }
            payloadIds.add(id);
            row.ownerProfileId = id;
            return row;
        }

        const used = new Set([...globalUsedIds, ...payloadIds]);
        id = generateOwnerProfileId(used);
        payloadIds.add(id);
        row.ownerProfileId = id;
        return row;
    });
}

export function validateOwnerProfileIdsUnique(owners = []) {
    const seen = new Set();
    for (const owner of owners) {
        const id = normalizeOwnerProfileId(owner?.ownerProfileId);
        if (!id) {
            return { ok: false, message: "Each owner must have a 4-digit Owner ID" };
        }
        if (seen.has(id)) {
            return { ok: false, message: `Duplicate Owner ID ${id} is not allowed` };
        }
        seen.add(id);
    }
    return { ok: true };
}
