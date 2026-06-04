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
