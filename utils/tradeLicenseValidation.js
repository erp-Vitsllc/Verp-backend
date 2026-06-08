import {
    assignOwnerProfileIds,
    normalizeOwnerProfileId,
    resolveOwnerProfileId,
} from "./ownerProfileId.js";

export {
    generateOwnerProfileId,
    resolveOwnerProfileId,
    normalizeOwnerProfileId,
    collectGlobalOwnerProfileIds,
    validateOwnerProfileIdsUnique,
} from "./ownerProfileId.js";

const LICENSE_REGEX = /^[A-Z0-9/-]{5,50}$/;
const OWNER_NAME_REGEX = /^[A-Za-z\s.'-]{2,100}$/;

export function sanitizeTradeLicenseField(val, fieldName) {
    if (val === undefined || val === null) return "";
    if (typeof val === "object" || Array.isArray(val)) {
        throw new Error(`Invalid data type for field ${fieldName}`);
    }
    let str = String(val).trim();
    str = str.replace(/<[^>]*>?/gm, "");
    return str;
}

export function normalizeTradeLicenseNumber(value) {
    return sanitizeTradeLicenseField(value, "License Number").toUpperCase();
}

function parseDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

function startOfDay(d) {
    const copy = new Date(d);
    copy.setHours(0, 0, 0, 0);
    return copy;
}

export function validateTradeLicenseNumber(value) {
    const normalized = normalizeTradeLicenseNumber(value);
    if (!normalized) return "License Number is required";
    if (normalized.length < 5) return "License Number must be at least 5 characters";
    if (normalized.length > 50) return "License Number must be no more than 50 characters";
    if (!LICENSE_REGEX.test(normalized)) {
        return "License Number may contain only letters, numbers, hyphens, and slashes";
    }
    return null;
}

export function validateTradeLicenseIssueDate(value) {
    if (!value) return "Issue Date is required";
    const d = parseDate(value);
    if (!d) return "Issue Date must be a valid date";
    if (d.getFullYear() < 1900) return "Issue Date minimum year is 1900";
    if (d > new Date()) return "Issue Date cannot be in the future";
    return null;
}

export function validateTradeLicenseExpiryDate(value, issueDate) {
    if (!value) return "Expiry Date is required";
    const expiry = parseDate(value);
    if (!expiry) return "Expiry Date must be a valid date";
    if (expiry.getFullYear() < 1900) return "Expiry Date minimum year is 1900";
    const issue = parseDate(issueDate);
    if (issue && expiry <= issue) return "Expiry Date must be greater than Issue Date";
    return null;
}

export function validateOwnerSharePercentage(value) {
    if (value === "" || value === null || value === undefined) return "Share % is required";
    const str = String(value).trim();
    if (!/^\d+(\.\d{1,2})?$/.test(str)) return "Share % must be a number with up to 2 decimal places";
    const num = Number(str);
    if (num < 0.01) return "Share % must be at least 0.01";
    if (num > 100) return "Share % cannot exceed 100";
    return null;
}

export function validateNewOwnerName(value) {
    const trimmed = sanitizeTradeLicenseField(value, "Owner Name");
    if (!trimmed) return "Owner name is required";
    if (trimmed.length < 2) return "Owner name must be at least 2 characters";
    if (trimmed.length > 100) return "Owner name must be no more than 100 characters";
    if (!OWNER_NAME_REGEX.test(trimmed)) return "Owner name may contain only letters, spaces, and . ' -";
    return null;
}

export function normalizeTradeLicenseOwners(owners = [], globalUsedIds = new Set()) {
    if (!Array.isArray(owners)) return [];
    const assigned = assignOwnerProfileIds(owners, globalUsedIds);
    return assigned.map((owner) => {
        const row = owner && typeof owner === "object" ? { ...owner } : {};
        row.name = sanitizeTradeLicenseField(row.name, "Owner Name");
        row.ownerProfileId = normalizeOwnerProfileId(row.ownerProfileId);
        if (row.sharePercentage != null) row.sharePercentage = String(row.sharePercentage).trim();
        return row;
    });
}

export function validateTradeLicenseOwnersPayload(owners = []) {
    if (!Array.isArray(owners) || owners.length === 0) {
        return { ok: false, message: "At least one owner is required" };
    }

    const profileIds = new Set();
    const names = new Set();
    let total = 0;

    for (const owner of owners) {
        const profileId = resolveOwnerProfileId(owner);
        if (!profileId) {
            return { ok: false, message: "Each owner must have a 4-digit Owner ID" };
        }
        if (profileIds.has(profileId)) {
            return { ok: false, message: `Duplicate Owner ID ${profileId} is not allowed` };
        }
        profileIds.add(profileId);

        const name = sanitizeTradeLicenseField(owner?.name, "Owner Name");
        if (!name) return { ok: false, message: "Owner name is required" };
        const nameKey = name.toLowerCase();
        if (names.has(nameKey)) {
            return { ok: false, message: "Duplicate owner name is not allowed" };
        }
        names.add(nameKey);

        const nameErr = validateNewOwnerName(name);
        if (nameErr) return { ok: false, message: nameErr };

        const shareErr = validateOwnerSharePercentage(owner?.sharePercentage);
        if (shareErr) return { ok: false, message: shareErr };
        total += Number(owner.sharePercentage);
    }

    if (Math.round(total * 100) / 100 !== 100) {
        return {
            ok: false,
            message: `Total owner share must equal exactly 100% (currently ${Math.round(total * 100) / 100}%)`,
        };
    }

    return { ok: true };
}

export function validateTradeLicensePayload(payload = {}, { requireAttachment = true } = {}) {
    const touched =
        Object.prototype.hasOwnProperty.call(payload, "tradeLicenseNumber") ||
        Object.prototype.hasOwnProperty.call(payload, "tradeLicenseIssueDate") ||
        Object.prototype.hasOwnProperty.call(payload, "tradeLicenseExpiry") ||
        Object.prototype.hasOwnProperty.call(payload, "tradeLicenseAttachment") ||
        Object.prototype.hasOwnProperty.call(payload, "owners");

    if (!touched) return { ok: true };

    const number = Object.prototype.hasOwnProperty.call(payload, "tradeLicenseNumber")
        ? payload.tradeLicenseNumber
        : undefined;
    const issueDate = Object.prototype.hasOwnProperty.call(payload, "tradeLicenseIssueDate")
        ? payload.tradeLicenseIssueDate
        : undefined;
    const expiry = Object.prototype.hasOwnProperty.call(payload, "tradeLicenseExpiry")
        ? payload.tradeLicenseExpiry
        : undefined;

    const numberErr = validateTradeLicenseNumber(number);
    if (numberErr) return { ok: false, message: numberErr };

    const issueErr = validateTradeLicenseIssueDate(issueDate);
    if (issueErr) return { ok: false, message: issueErr };

    const expiryErr = validateTradeLicenseExpiryDate(expiry, issueDate);
    if (expiryErr) return { ok: false, message: expiryErr };

    if (requireAttachment && !payload.tradeLicenseAttachment) {
        return { ok: false, message: "PDF attachment is required" };
    }

    if (Object.prototype.hasOwnProperty.call(payload, "owners")) {
        const ownersCheck = validateTradeLicenseOwnersPayload(payload.owners);
        if (!ownersCheck.ok) return ownersCheck;
    }

    return { ok: true };
}
