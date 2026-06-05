import {
    mergeCompanyOwnersSnapshot,
    OWNER_NESTED_DOC_KEYS,
} from "./mergeCompanyOwnersSnapshot.js";
import {
    normalizeOwnerEmail,
    normalizeOwnerPhone,
} from "./ownerDetailsValidation.js";

const OWNER_BASIC_SCALAR_KEYS = [
    "name",
    "email",
    "phone",
    "phoneCountryCode",
    "nationality",
    "sharePercentage",
];

/** Contact/detail fields only — excludes share % (auto-redistribute must not validate other owners). */
const OWNER_CONTACT_DETAIL_KEYS = [
    "name",
    "email",
    "phone",
    "phoneCountryCode",
    "nationality",
];

const scalarFieldEqual = (key, baseVal, patchVal) => {
    if (key === "email") {
        return normalizeOwnerEmail(baseVal) === normalizeOwnerEmail(patchVal);
    }
    if (key === "phone") {
        return normalizeOwnerPhone(baseVal) === normalizeOwnerPhone(patchVal);
    }
    return String(baseVal ?? "").trim() === String(patchVal ?? "").trim();
};

/** True when the patch changes name/email/phone/nationality/share vs the live owner row. */
export const ownerPatchTouchesBasicScalarFields = (patch = {}, base = {}) => {
    if (!patch || typeof patch !== "object") return false;
    return OWNER_BASIC_SCALAR_KEYS.some((key) => {
        if (!Object.prototype.hasOwnProperty.call(patch, key)) return false;
        return !scalarFieldEqual(key, base[key], patch[key]);
    });
};

const ownerPatchTouchesContactDetailFields = (patch = {}, base = {}) => {
    if (!patch || typeof patch !== "object") return false;
    return OWNER_CONTACT_DETAIL_KEYS.some((key) => {
        if (!Object.prototype.hasOwnProperty.call(patch, key)) return false;
        return !scalarFieldEqual(key, base[key], patch[key]);
    });
};

/** Owner row indexes whose contact/basic fields changed (not share-only redistribute). */
export const getOwnerIndicesWithContactDetailChanges = (patchOwners = [], baseOwners = []) => {
    if (!Array.isArray(patchOwners) || patchOwners.length === 0) return [];
    const indices = [];
    patchOwners.forEach((patch, index) => {
        const base = findBaseOwner(patch, baseOwners, index);
        if (ownerPatchTouchesContactDetailFields(patch, base)) {
            indices.push(index);
        }
    });
    return indices;
};

const findBaseOwner = (patch, baseOwners, index) => {
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

/**
 * Saving passport / labour card / visa etc. sends full owner rows but only nested doc data changed.
 * Skip owner basic-details validation in that case (labour card does not require email).
 */
export const isOwnerNestedDocOnlyOwnersUpdate = (patchOwners = [], baseOwners = []) => {
    if (!Array.isArray(patchOwners) || patchOwners.length === 0) return false;

    const merged = mergeCompanyOwnersSnapshot(baseOwners, patchOwners);
    let anyNestedChanged = false;
    for (let index = 0; index < merged.length; index++) {
        const mergedRow = merged[index];
        const base = findBaseOwner(mergedRow, baseOwners, index);
        if (ownerPatchTouchesBasicScalarFields(mergedRow, base)) return false;
        if (ownerRowNestedDocsChanged(mergedRow, base)) anyNestedChanged = true;
    }
    return anyNestedChanged;
};

const nestedDocHasContent = (doc) => {
    if (!doc || typeof doc !== "object") return false;
    const scalarKeys = ["number", "nationality", "type", "provider", "issueDate", "expiryDate", "sponsor"];
    if (scalarKeys.some((k) => doc[k] != null && String(doc[k]).trim() !== "")) return true;
    const att = doc.attachment;
    if (!att) return false;
    if (typeof att === "string") return String(att).trim() !== "";
    return Boolean(att?.url || att?.publicId || att?.data);
};

const nestedDocFieldEqual = (left, right) => {
    if (left == null && right == null) return true;
    if (left == null || right == null) {
        const doc = left || right;
        if (typeof doc !== "object") return String(left ?? "") === String(right ?? "");
        return !nestedDocHasContent(doc);
    }
    if (typeof left !== "object" || typeof right !== "object") {
        return String(left) === String(right);
    }
    try {
        return JSON.stringify(left) === JSON.stringify(right);
    } catch {
        return false;
    }
};

/** True when passport / EID / visa etc. on a row differ from the live owner snapshot. */
export const ownerRowNestedDocsChanged = (mergedRow = {}, baseRow = {}) =>
    OWNER_NESTED_DOC_KEYS.some((key) => !nestedDocFieldEqual(mergedRow?.[key], baseRow?.[key]));

/** Owner row indexes whose nested doc card (e.g. emiratesId) changed vs the live snapshot. */
export const getOwnerIndicesWithNestedDocChange = (patchOwners = [], baseOwners = [], docKey) => {
    if (!docKey || !Array.isArray(patchOwners) || patchOwners.length === 0) return [];
    const merged = mergeCompanyOwnersSnapshot(baseOwners, patchOwners);
    const indices = [];
    merged.forEach((mergedRow, index) => {
        const base = findBaseOwner(mergedRow, baseOwners, index);
        if (!nestedDocFieldEqual(mergedRow?.[docKey], base?.[docKey])) {
            indices.push(index);
        }
    });
    return indices;
};

/** Nested doc card keys that differ from the live owner snapshot (passport-only save → Set { passport }). */
export const getChangedOwnerNestedDocKeys = (patchOwners = [], baseOwners = []) => {
    if (!Array.isArray(patchOwners) || patchOwners.length === 0) return new Set();
    const merged = mergeCompanyOwnersSnapshot(baseOwners, patchOwners);
    const changedKeys = new Set();
    merged.forEach((mergedRow, index) => {
        const base = findBaseOwner(mergedRow, baseOwners, index);
        for (const key of OWNER_NESTED_DOC_KEYS) {
            if (!nestedDocFieldEqual(mergedRow?.[key], base?.[key])) {
                changedKeys.add(key);
            }
        }
    });
    return changedKeys;
};
