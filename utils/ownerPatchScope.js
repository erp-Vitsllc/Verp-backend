import {
    mergeCompanyOwnersSnapshot,
    OWNER_NESTED_DOC_KEYS,
} from "./mergeCompanyOwnersSnapshot.js";
import {
    normalizeOwnerEmail,
    normalizeOwnerPhone,
} from "./ownerDetailsValidation.js";
import { normalizeOwnerProfileId } from "./ownerProfileId.js";

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

const findBaseOwnerStrict = (patch, baseOwners = []) => {
    if (patch?._id != null) {
        const hit = baseOwners.find((b) => String(b?._id) === String(patch._id));
        if (hit) return hit;
    }
    const profileId = normalizeOwnerProfileId(patch?.ownerProfileId);
    if (profileId) {
        const hit = baseOwners.find(
            (b) => normalizeOwnerProfileId(b?.ownerProfileId) === profileId,
        );
        if (hit) return hit;
    }
    return null;
};

const TRADE_LICENSE_ROSTER_PROFILE_KEYS = [
    "name",
    "email",
    "phone",
    "phoneCountryCode",
    "nationality",
];

/** Name / contact edits on an existing roster member — not share-only edits or new links. */
const tradeLicenseOwnerTouchesBlockedProfileFields = (patch = {}, base = {}) =>
    TRADE_LICENSE_ROSTER_PROFILE_KEYS.some((key) => {
        if (!Object.prototype.hasOwnProperty.call(patch, key)) return false;
        return !scalarFieldEqual(key, base[key], patch[key]);
    });

const collectTradeLicenseBundleProfileMutations = (patchOwners = [], baseOwners = []) => {
    const mutated = new Set();
    const patch = Array.isArray(patchOwners) ? patchOwners : [];
    const base = Array.isArray(baseOwners) ? baseOwners : [];

    const patchProfileIds = new Set();
    for (const row of patch) {
        const pid = normalizeOwnerProfileId(row?.ownerProfileId);
        if (pid) patchProfileIds.add(pid);
    }

    for (const row of base) {
        const pid = normalizeOwnerProfileId(row?.ownerProfileId);
        if (pid && !patchProfileIds.has(pid)) {
            mutated.add(pid);
        }
    }

    for (const row of patch) {
        const pid = normalizeOwnerProfileId(row?.ownerProfileId);
        if (!pid) continue;
        const baseRow = findBaseOwnerStrict(row, base);
        if (!baseRow) continue;
        if (tradeLicenseOwnerTouchesBlockedProfileFields(row, baseRow)) {
            mutated.add(pid);
        }
    }

    return [...mutated];
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

const normalizeAttachmentRef = (att) => {
    if (att == null) return "";
    if (typeof att === "string") return String(att).trim();
    if (typeof att === "object") {
        return String(att.publicId || att.url || att.data || "").trim();
    }
    return String(att).trim();
};

const NESTED_DOC_COMPARE_SCALAR_KEYS = [
    "number",
    "nationality",
    "type",
    "provider",
    "issueDate",
    "expiryDate",
    "sponsor",
    "countryOfIssue",
    "placeOfIssue",
    "issuingCountry",
    "lastUpdated",
];

const snapshotNestedDoc = (doc, docKey) => {
    if (!doc || typeof doc !== "object") return null;
    const snap = {};
    for (const k of NESTED_DOC_COMPARE_SCALAR_KEYS) {
        if (doc[k] == null) continue;
        snap[k] = String(doc[k]).trim();
    }
    const att = normalizeAttachmentRef(doc.attachment);
    if (att) snap.attachment = att;
    if (docKey === "emiratesId" && snap.number) {
        snap.number = String(snap.number).replace(/\D/g, "");
    }
    if (docKey === "labourCard" && snap.number) {
        snap.number = String(snap.number).replace(/\s/g, "");
    }
    return Object.keys(snap).length > 0 ? snap : null;
};

const nestedDocFieldEqual = (left, right, docKey = "") => {
    if (left == null && right == null) return true;
    if (left == null || right == null) {
        const doc = left || right;
        if (typeof doc !== "object") return String(left ?? "") === String(right ?? "");
        return !nestedDocHasContent(doc);
    }
    if (typeof left !== "object" || typeof right !== "object") {
        return String(left) === String(right);
    }
    const ls = snapshotNestedDoc(left, docKey);
    const rs = snapshotNestedDoc(right, docKey);
    if (!ls && !rs) return true;
    if (!ls || !rs) return false;
    return JSON.stringify(ls) === JSON.stringify(rs);
};

/** True when passport / EID / visa etc. on a row differ from the live owner snapshot. */
export const ownerRowNestedDocsChanged = (mergedRow = {}, baseRow = {}) =>
    OWNER_NESTED_DOC_KEYS.some((key) => !nestedDocFieldEqual(mergedRow?.[key], baseRow?.[key], key));

/** Owner row indexes whose nested doc card (e.g. emiratesId) changed vs the live snapshot. */
export const getOwnerIndicesWithNestedDocChange = (patchOwners = [], baseOwners = [], docKey) => {
    if (!docKey || !Array.isArray(patchOwners) || patchOwners.length === 0) return [];
    const merged = mergeCompanyOwnersSnapshot(baseOwners, patchOwners);
    const indices = [];
    merged.forEach((mergedRow, index) => {
        const base = findBaseOwner(mergedRow, baseOwners, index);
        if (!nestedDocFieldEqual(mergedRow?.[docKey], base?.[docKey], docKey)) {
            indices.push(index);
        }
    });
    return indices;
};

/**
 * Owner profile ids whose shared data changed (contact fields, nested docs, attachment, or roster removal).
 * Share-%-only / Trade License license-field saves do not count as profile mutations.
 */
export const collectOwnerProfileIdsWithSharedProfileMutations = (
    patchOwners = [],
    baseOwners = [],
    options = {},
) => {
    const { rosterReplace = false, tradeLicenseBundle = false } = options;
    if (tradeLicenseBundle) {
        return collectTradeLicenseBundleProfileMutations(patchOwners, baseOwners);
    }
    const mutated = new Set();
    const patch = Array.isArray(patchOwners) ? patchOwners : [];
    const base = Array.isArray(baseOwners) ? baseOwners : [];

    const patchProfileIds = new Set();
    for (const row of patch) {
        const pid = normalizeOwnerProfileId(row?.ownerProfileId);
        if (pid) patchProfileIds.add(pid);
    }

    for (const row of base) {
        const pid = normalizeOwnerProfileId(row?.ownerProfileId);
        if (pid && !patchProfileIds.has(pid)) {
            mutated.add(pid);
        }
    }

    const merged = rosterReplace ? null : mergeCompanyOwnersSnapshot(base, patch);
    const rowsToCheck = rosterReplace ? patch : merged;

    rowsToCheck.forEach((row, index) => {
        const baseRow = findBaseOwner(row, base, index);
        const pid = normalizeOwnerProfileId(row?.ownerProfileId || baseRow?.ownerProfileId);
        if (!pid) return;

        if (ownerPatchTouchesContactDetailFields(row, baseRow)) {
            mutated.add(pid);
            return;
        }

        const mergedForNested = rosterReplace ? { ...baseRow, ...row } : row;
        if (ownerRowNestedDocsChanged(mergedForNested, baseRow)) {
            mutated.add(pid);
        }

        if (
            Object.prototype.hasOwnProperty.call(row, "attachment") &&
            String(row.attachment ?? "").trim() !== String(baseRow?.attachment ?? "").trim()
        ) {
            mutated.add(pid);
        }
    });

    return [...mutated];
};

/** Nested doc card keys that differ from the live owner snapshot (passport-only save → Set { passport }). */
export const getChangedOwnerNestedDocKeys = (patchOwners = [], baseOwners = []) => {
    if (!Array.isArray(patchOwners) || patchOwners.length === 0) return new Set();
    const merged = mergeCompanyOwnersSnapshot(baseOwners, patchOwners);
    const changedKeys = new Set();
    merged.forEach((mergedRow, index) => {
        const base = findBaseOwner(mergedRow, baseOwners, index);
        for (const key of OWNER_NESTED_DOC_KEYS) {
            if (!nestedDocFieldEqual(mergedRow?.[key], base?.[key], key)) {
                changedKeys.add(key);
            }
        }
    });
    return changedKeys;
};
