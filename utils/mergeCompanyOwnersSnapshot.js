export const TRADE_LICENSE_OWNER_BUNDLE_KEYS = [
    "tradeLicenseNumber",
    "tradeLicenseIssueDate",
    "tradeLicenseExpiry",
    "tradeLicenseAttachment",
    "tradeLicenseOwnerName",
];

/** Trade License modal sends license fields + the full intended owner roster. */
export const isTradeLicenseOwnersBundleUpdate = (updateData = {}) =>
    Object.prototype.hasOwnProperty.call(updateData, "owners") &&
    TRADE_LICENSE_OWNER_BUNDLE_KEYS.some((k) => Object.prototype.hasOwnProperty.call(updateData, k));

/** Fewer owners in patch — each row matches an existing owner id (removal, not a doc-card slice). */
export const isOwnerRosterRemovalPatch = (beforeOwners = [], patchOwners = []) => {
    const before = Array.isArray(beforeOwners) ? beforeOwners : [];
    const patch = Array.isArray(patchOwners) ? patchOwners : [];
    if (patch.length === 0 || patch.length >= before.length) return false;
    return patch.every((p) => {
        const id = p?._id ?? p?.id;
        if (id == null) return false;
        return before.some((b) => String(b?._id ?? b?.id ?? "") === String(id));
    });
};

/**
 * HR-approved owner patches: merge doc-card slices; replace roster for Trade License edits
 * or when the queue row was saved with `__ownersReplaceRoster` (owner removed from roster).
 */
export const resolveOwnersForActivationApply = (beforeOwners = [], proposedData = {}) => {
    const patchOwners = proposedData?.owners;
    if (!Array.isArray(patchOwners)) return null;
    if (isTradeLicenseOwnersBundleUpdate(proposedData) || proposedData.__ownersReplaceRoster === true) {
        return replaceCompanyOwnersFromTradeLicensePatch(beforeOwners, patchOwners);
    }
    return mergeCompanyOwnersSnapshot(beforeOwners, patchOwners);
};

/** Nested owner document cards — merge per key instead of replacing the whole owner row. */
export const OWNER_NESTED_DOC_KEYS = [
    "passport",
    "emiratesId",
    "visa",
    "visitVisa",
    "employmentVisa",
    "spouseVisa",
    "labourCard",
    "medical",
    "drivingLicense",
];

const findBaseOwnerForPatch = (patch, baseOwners, index) => {
    if (patch?._id != null) {
        const hit = baseOwners.find((b) => String(b?._id) === String(patch._id));
        if (hit) return hit;
    }
    const profileId = patch?.ownerProfileId;
    if (profileId != null && String(profileId).trim() !== "") {
        const hit = baseOwners.find(
            (b) =>
                b?.ownerProfileId != null &&
                String(b.ownerProfileId) === String(profileId),
        );
        if (hit) return hit;
    }
    return baseOwners[index] || {};
};

const mergeOwnerRow = (base = {}, patch = {}) => {
    if (!patch || typeof patch !== "object") return { ...base };
    const out = { ...base };
    for (const k of Object.keys(patch)) {
        if (OWNER_NESTED_DOC_KEYS.includes(k)) continue;
        if (patch[k] !== undefined) out[k] = patch[k];
    }
    for (const docKey of OWNER_NESTED_DOC_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(patch, docKey)) continue;
        if (patch[docKey] == null) {
            delete out[docKey];
            continue;
        }
        if (typeof patch[docKey] === "object") {
            out[docKey] =
                typeof base?.[docKey] === "object" && base[docKey] !== null
                    ? { ...base[docKey], ...patch[docKey] }
                    : { ...patch[docKey] };
        } else {
            out[docKey] = patch[docKey];
        }
    }
    return out;
};

/**
 * Trade License modal sends the full intended owner list (add/remove/share).
 * Replace the array — do not keep owners removed in the modal — while preserving
 * nested doc cards (passport, EID, etc.) for owners that remain.
 */
export const replaceCompanyOwnersFromTradeLicensePatch = (baseOwners = [], patchOwners = []) => {
    if (!Array.isArray(patchOwners)) return Array.isArray(baseOwners) ? [...baseOwners] : [];
    if (patchOwners.length === 0) return [];
    return patchOwners.map((patch, index) => {
        const base = findBaseOwnerForPatch(patch, baseOwners, index);
        return mergeOwnerRow(base, patch);
    });
};

/**
 * Combine owner rows when overlaying pending HR patches or merging queue entries.
 * Prevents saving Emirates ID from dropping a previously queued/saved Passport on the same owner.
 */
export const mergeCompanyOwnersSnapshot = (baseOwners = [], patchOwners = []) => {
    if (!Array.isArray(patchOwners) || patchOwners.length === 0) {
        return Array.isArray(baseOwners) ? baseOwners : [];
    }
    if (!Array.isArray(baseOwners) || baseOwners.length === 0) {
        return patchOwners.map((o) => ({ ...o }));
    }

    const result = baseOwners.map((base, i) => {
        const patch =
            patchOwners.find(
                (p) =>
                    base?._id != null &&
                    p?._id != null &&
                    String(p._id) === String(base._id),
            ) ?? patchOwners[i];
        if (!patch) return { ...base };
        return mergeOwnerRow(base, patch);
    });

    patchOwners.forEach((patch, i) => {
        const id = patch?._id;
        if (id != null && baseOwners.some((b) => String(b?._id) === String(id))) return;
        if (id == null && baseOwners[i]) return;
        result.push({ ...patch });
    });

    return result;
};
