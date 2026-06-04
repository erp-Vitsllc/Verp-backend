import { validateOwnerSharePercentage } from "./tradeLicenseValidation.js";

const FULL_NAME_REGEX = /^[A-Za-z\s.-]{3,100}$/;
const EMAIL_REGEX = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const PHONE_REGEX = /^\+?[0-9]{7,15}$/;
const NATIONALITY_REGEX = /^[A-Za-z][A-Za-z\s.'()-]{0,98}[A-Za-z.)]?$/;

export function stripDangerousText(value) {
    if (value === undefined || value === null) return "";
    if (typeof value === "object" || Array.isArray(value)) {
        throw new Error("Invalid data type for owner field");
    }
    let str = String(value).trim();
    str = str.replace(/<[^>]*>?/gm, "");
    return str;
}

export function normalizeOwnerFullName(value) {
    return stripDangerousText(value);
}

export function normalizeOwnerEmail(value) {
    const raw = stripDangerousText(value).replace(/\s/g, "");
    return raw ? raw.toLowerCase() : "";
}

export function normalizeOwnerPhone(value) {
    const stripped = stripDangerousText(value).replace(/[\s\-()]/g, "");
    if (!stripped) return "";
    if (stripped.startsWith("+")) {
        const digits = stripped.slice(1).replace(/\D/g, "");
        return digits ? `+${digits}` : "";
    }
    return stripped.replace(/\D/g, "");
}

/** Per-owner: activated profile requires all rows; otherwise only rows with contact/nationality set. */
export function ownerRowNeedsDetailValidation(owner, profileActive = false) {
    if (profileActive) return true;
    return (
        String(owner?.phone || "").trim() !== "" ||
        String(owner?.nationality || "").trim() !== ""
    );
}

export function normalizeOwnerNationality(value) {
    return stripDangerousText(value);
}

export function validateOwnerFullName(value) {
    const name = normalizeOwnerFullName(value);
    if (!name) return "Full Name is required";
    if (name.length < 3) return "Full Name must be at least 3 characters";
    if (name.length > 100) return "Full Name must be no more than 100 characters";
    if (!FULL_NAME_REGEX.test(name)) {
        return "Full Name may contain only letters, spaces, and . -";
    }
    return null;
}

/** Read email from an owner row (handles string or legacy shapes). */
export function getOwnerRowEmail(owner) {
    if (!owner || typeof owner !== "object") return "";
    const raw = owner.email ?? owner.contactEmail ?? "";
    return normalizeOwnerEmail(raw);
}

export function validateOwnerEmail(value, { requireEmail = false } = {}) {
    const email =
        value && typeof value === "object"
            ? getOwnerRowEmail(value)
            : normalizeOwnerEmail(value);
    if (!email) {
        return requireEmail ? "Email Address is required" : null;
    }
    if (email.length < 5) return "Email Address must be at least 5 characters";
    if (email.length > 150) return "Email Address must be no more than 150 characters";
    if (!EMAIL_REGEX.test(email)) return "Email Address must be a valid email format";
    return null;
}

export function validateOwnerPhone(value) {
    const phone = normalizeOwnerPhone(value);
    if (!phone) return "Contact Number is required";
    if (!PHONE_REGEX.test(phone)) {
        return "Contact Number must be 7–15 digits; optional leading + only";
    }
    return null;
}

export function validateOwnerNationality(value) {
    const nationality = normalizeOwnerNationality(value);
    if (!nationality) return "Nationality is required";
    if (!NATIONALITY_REGEX.test(nationality)) {
        return "Nationality must be a valid country name";
    }
    return null;
}

export function validateOwnerEmailUniqueAmongOwners(email, owners = [], skipIndex = -1) {
    const normalized = normalizeOwnerEmail(email);
    if (!normalized) return null;
    for (let i = 0; i < owners.length; i++) {
        if (i === skipIndex) continue;
        const other = getOwnerRowEmail(owners[i]);
        if (other && other === normalized) {
            return "Email Address must be unique among owners";
        }
    }
    return null;
}

export function normalizeOwnerDetailsRow(owner) {
    if (!owner || typeof owner !== "object") return owner;
    const row = { ...owner };
    if (row.name !== undefined) row.name = normalizeOwnerFullName(row.name);
    if (row.email !== undefined) row.email = normalizeOwnerEmail(row.email);
    if (row.phone !== undefined) row.phone = normalizeOwnerPhone(row.phone);
    if (row.nationality !== undefined) row.nationality = normalizeOwnerNationality(row.nationality);
    if (row.sharePercentage != null) row.sharePercentage = String(row.sharePercentage).trim();
    return row;
}

export function validateOwnerDetailsOwnersPayload(
    owners = [],
    { requireEmail = false, profileActive = false } = {},
) {
    if (!Array.isArray(owners) || owners.length === 0) {
        return { ok: false, message: "At least one owner is required" };
    }

    const emails = new Set();

    for (let i = 0; i < owners.length; i++) {
        const owner = owners[i];
        const nameErr = validateOwnerFullName(owner?.name);
        if (nameErr) return { ok: false, message: nameErr };

        const shareErr = validateOwnerSharePercentage(owner?.sharePercentage);
        if (shareErr) return { ok: false, message: shareErr };

        if (!ownerRowNeedsDetailValidation(owner, profileActive)) continue;

        const emailErr = validateOwnerEmail(getOwnerRowEmail(owner), {
            requireEmail: profileActive || requireEmail,
        });
        if (emailErr) {
            const label = String(owner?.name || "").trim() || `Owner ${i + 1}`;
            return { ok: false, message: `${label}: ${emailErr}` };
        }

        const emailKey = getOwnerRowEmail(owner);
        if (emailKey) {
            if (emails.has(emailKey)) {
                return { ok: false, message: "Email Address must be unique among owners" };
            }
            emails.add(emailKey);
        }

        const phoneErr = validateOwnerPhone(owner?.phone);
        if (phoneErr) return { ok: false, message: phoneErr };

        const natErr = validateOwnerNationality(owner?.nationality);
        if (natErr) return { ok: false, message: natErr };
    }

    let total = 0;
    for (const owner of owners) {
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
