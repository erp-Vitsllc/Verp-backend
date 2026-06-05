import { mergePendingReactivationForActivationSnapshot } from "./companyActivation.js";
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

function findOwnerIndex(owners = [], { ownerIndex, ownerProfileId }) {
    const coerced = coerceOwnerIndex(ownerIndex);
    if (ownerProfileId != null && String(ownerProfileId).trim() !== "") {
        const pid = String(ownerProfileId).trim();
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

/**
 * Resolve an owner document from partitioned profile data (owners slice + pending queue overlay).
 * Returns null when neither live nor queued data contains the document.
 */
export function resolveOwnerDocumentForNotRenew(companyData = {}, target = {}) {
    const docKey = normalizeOwnerDocKey(target.docKey);
    if (!docKey) return null;

    const liveOwners = Array.isArray(companyData?.owners) ? companyData.owners : [];
    const ownerIndex = findOwnerIndex(liveOwners, target);
    if (ownerIndex == null || ownerIndex < 0) return null;

    const liveOwner = liveOwners[ownerIndex];
    const liveDoc = liveOwner?.[docKey];
    const hasLive = ownerDocHasContent(liveDoc);

    const effectiveCompany = mergePendingReactivationForActivationSnapshot(companyData);
    const effectiveOwners = Array.isArray(effectiveCompany?.owners) ? effectiveCompany.owners : [];
    const effectiveOwner = effectiveOwners[ownerIndex];
    const effectiveDoc = effectiveOwner?.[docKey];
    const hasEffective = ownerDocHasContent(effectiveDoc);

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
