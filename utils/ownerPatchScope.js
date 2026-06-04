import { mergeCompanyOwnersSnapshot, OWNER_NESTED_DOC_KEYS } from "./mergeCompanyOwnersSnapshot.js";
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
    return baseOwners[index] || {};
};

/**
 * Saving passport / labour card / visa etc. sends full owner rows but only nested doc data changed.
 * Skip owner basic-details validation in that case (labour card does not require email).
 */
export const isOwnerNestedDocOnlyOwnersUpdate = (patchOwners = [], baseOwners = []) => {
    if (!Array.isArray(patchOwners) || patchOwners.length === 0) return false;

    return patchOwners.every((patch, index) => {
        const base = findBaseOwner(patch, baseOwners, index);
        const touchesBasic = ownerPatchTouchesBasicScalarFields(patch, base);
        const touchesNested = OWNER_NESTED_DOC_KEYS.some(
            (key) =>
                Object.prototype.hasOwnProperty.call(patch, key) &&
                patch[key] != null &&
                typeof patch[key] === "object",
        );
        return touchesNested && !touchesBasic;
    });
};
