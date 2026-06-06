import { mergePendingReactivationForActivationSnapshot } from "./companyActivation.js";
import { dedupeCompanyOwnersList } from "./globalOwnersCatalog.js";
import { OWNER_NESTED_DOC_KEYS } from "./mergeCompanyOwnersSnapshot.js";

export function coerceOwnerIndex(value) {
    if (typeof value === "number" && !Number.isNaN(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
        const n = Number(value);
        if (!Number.isNaN(n)) return n;
    }
    return null;
}

export function normalizeOwnerDocKey(docKey) {
    const k = String(docKey || "").trim();
    if (!k) return "";
    const lower = k.toLowerCase();
    if (lower === "emiratesid" || lower === "emirates_id") return "emiratesId";
    if (lower === "drivinglicense" || lower === "driving_license") return "drivingLicense";
    if (lower === "labourcard" || lower === "labour_card") return "labourCard";
    return k;
}

export function ownerDocHasContent(docObj) {
    if (!docObj || typeof docObj !== "object") return false;
    const scalarKeys = [
        "number",
        "idNumber",
        "nationality",
        "type",
        "provider",
        "issueDate",
        "expiryDate",
        "startDate",
        "countryOfIssue",
        "issuingCountry",
        "sponsor",
        "lastUpdated",
    ];
    if (
        scalarKeys.some((key) => {
            const v = docObj[key];
            return v != null && String(v).trim() !== "";
        })
    ) {
        return true;
    }
    const att = docObj.attachment;
    if (!att) return false;
    const url = typeof att === "string" ? att : att?.url;
    return Boolean(url && String(url).trim());
}

function findOwnerIndex(owners = [], target = {}) {
    const coerced = coerceOwnerIndex(target.ownerIndex);
    if (target.ownerProfileId != null && String(target.ownerProfileId).trim() !== "") {
        const pid = String(target.ownerProfileId).trim();
        const byProfile = owners.findIndex(
            (o) =>
                (o?.ownerProfileId != null && String(o.ownerProfileId) === pid) ||
                (o?._id != null && String(o._id) === pid),
        );
        if (byProfile >= 0) return byProfile;
    }
    if (coerced != null && owners[coerced]) return coerced;
    return coerced;
}

/** Prefer the owner row that actually holds the nested doc (handles duplicate roster rows). */
function findOwnerIndexWithDoc(owners = [], target = {}, docKey = "") {
    const dk = normalizeOwnerDocKey(docKey);
    if (!dk) return findOwnerIndex(owners, target);

    const coerced = coerceOwnerIndex(target.ownerIndex);
    if (coerced != null && ownerDocHasContent(owners[coerced]?.[dk])) {
        return coerced;
    }

    const pid =
        target.ownerProfileId != null && String(target.ownerProfileId).trim() !== ""
            ? String(target.ownerProfileId).trim()
            : "";
    if (pid) {
        for (let i = 0; i < owners.length; i++) {
            const row = owners[i];
            if (
                ((row?.ownerProfileId != null && String(row.ownerProfileId) === pid) ||
                    (row?._id != null && String(row._id) === pid)) &&
                ownerDocHasContent(row?.[dk])
            ) {
                return i;
            }
        }
    }

    return findOwnerIndex(owners, target);
}

/** Clear a nested owner doc from every live row matching the not-renew target. */
export function clearOwnerDocFromAllMatchingRows(owners = [], target = {}, docKey = "") {
    const dk = normalizeOwnerDocKey(docKey);
    if (!dk || !Array.isArray(owners)) return owners;

    const coerced = coerceOwnerIndex(target.ownerIndex);
    const pid =
        target.ownerProfileId != null && String(target.ownerProfileId).trim() !== ""
            ? String(target.ownerProfileId).trim()
            : "";

    const next = owners.map((row, idx) => {
        if (!row || typeof row !== "object") return row;
        const matchesProfile =
            pid &&
            ((row?.ownerProfileId != null && String(row.ownerProfileId) === pid) ||
                (row?._id != null && String(row._id) === pid));
        const matchesIndex = coerced != null && idx === coerced;
        if (!matchesProfile && !matchesIndex) return row;
        if (!ownerDocHasContent(row[dk]) && row[dk] == null) return row;
        return { ...row, [dk]: null };
    });

    return dedupeCompanyOwnersList(next);
}

/**
 * Resolve an owner document from partitioned profile data (owners slice + pending queue overlay).
 * Returns null when neither live nor queued data contains the document.
 */
export function resolveOwnerDocumentForNotRenew(companyData = {}, target = {}) {
    const docKey = normalizeOwnerDocKey(target.docKey);
    if (!docKey) return null;

    const liveOwners = Array.isArray(companyData?.owners) ? companyData.owners : [];
    const effectiveCompany = mergePendingReactivationForActivationSnapshot(companyData);
    const effectiveOwners = Array.isArray(effectiveCompany?.owners) ? effectiveCompany.owners : [];

    let ownerIndex = findOwnerIndexWithDoc(liveOwners, target, docKey);
    if (ownerIndex == null || ownerIndex < 0) {
        ownerIndex = findOwnerIndex(liveOwners, target);
    }
    if (ownerIndex == null || ownerIndex < 0) return null;

    let liveOwner = liveOwners[ownerIndex];
    let liveDoc = liveOwner?.[docKey];
    let hasLive = ownerDocHasContent(liveDoc);

    let effectiveOwner = effectiveOwners[ownerIndex];
    let effectiveDoc = effectiveOwner?.[docKey];
    let hasEffective = ownerDocHasContent(effectiveDoc);

    if (!hasLive && !hasEffective) {
        const effectiveIndex = findOwnerIndexWithDoc(effectiveOwners, target, docKey);
        if (effectiveIndex != null && effectiveIndex >= 0) {
            ownerIndex = effectiveIndex;
            liveOwner = liveOwners[ownerIndex];
            liveDoc = liveOwner?.[docKey];
            hasLive = ownerDocHasContent(liveDoc);
            effectiveOwner = effectiveOwners[ownerIndex];
            effectiveDoc = effectiveOwner?.[docKey];
            hasEffective = ownerDocHasContent(effectiveDoc);
        }
    }

    if (!hasLive && !hasEffective) return null;

    return {
        ownerIndex,
        docKey,
        owner: liveOwner || effectiveOwner,
        ownerName: (liveOwner || effectiveOwner)?.name || `Owner ${ownerIndex + 1}`,
        liveDoc: hasLive ? liveDoc : null,
        effectiveDoc: hasEffective ? effectiveDoc : null,
        archiveDoc: hasLive ? liveDoc : effectiveDoc,
        pendingOnly: !hasLive && hasEffective,
    };
}

/** Remove a queued owner doc from pendingReactivationChanges after not-renew is approved. */
export function stripOwnerDocFromPendingReactivationChanges(pending = [], ownerIndex, docKey) {
    const dk = normalizeOwnerDocKey(docKey);
    const oi = coerceOwnerIndex(ownerIndex);
    if (oi == null || !dk || !Array.isArray(pending)) return pending;

    const rowStillHasPatch = (row) => {
        if (!row || typeof row !== "object") return false;
        return Object.keys(row).some((k) => {
            if (OWNER_NESTED_DOC_KEYS.includes(k)) return ownerDocHasContent(row[k]);
            return row[k] != null && String(row[k]).trim() !== "";
        });
    };

    return pending
        .map((entry) => {
            const proposed = entry?.proposedData;
            if (!proposed || !Array.isArray(proposed.owners)) return entry;

            const nextOwners = proposed.owners.map((row, idx) => {
                if (idx !== oi) return row;
                if (!row || typeof row !== "object") return row;
                if (!Object.prototype.hasOwnProperty.call(row, dk)) return row;
                return { ...row, [dk]: null };
            });

            const stillHasOwnerPatch = nextOwners.some((row) => rowStillHasPatch(row));
            if (!stillHasOwnerPatch) {
                const { owners: _removed, ...restProposed } = proposed;
                const hasOtherProposed = Object.keys(restProposed).length > 0;
                if (!hasOtherProposed) return null;
                return { ...entry, proposedData: restProposed };
            }

            return { ...entry, proposedData: { ...proposed, owners: nextOwners } };
        })
        .filter(Boolean);
}
