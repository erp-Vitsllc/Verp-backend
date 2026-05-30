const PASSPORT_NUMBER_REGEX = /^[A-Z0-9]{6,15}$/;
const NATIONALITY_REGEX = /^[A-Za-z][A-Za-z\s.'()-]{0,98}[A-Za-z.)]?$/;

export function stripDangerousText(value) {
    if (value === undefined || value === null) return "";
    if (typeof value === "object" || Array.isArray(value)) {
        throw new Error("Invalid data type for passport field");
    }
    let str = String(value).trim();
    str = str.replace(/<[^>]*>?/gm, "");
    return str;
}

export function normalizePassportNumber(value) {
    return stripDangerousText(value).replace(/\s/g, "").toUpperCase();
}

export function normalizePassportNationality(value) {
    return stripDangerousText(value);
}

export function normalizePassportCountryOfIssue(value) {
    return stripDangerousText(value);
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

export function validatePassportNumber(value, { existingNumbers = [], skipNumber = "" } = {}) {
    const normalized = normalizePassportNumber(value);
    if (!normalized) return "Passport Number is required";
    if (normalized.length < 6) return "Passport Number must be at least 6 characters";
    if (normalized.length > 15) return "Passport Number must be no more than 15 characters";
    if (!PASSPORT_NUMBER_REGEX.test(normalized)) {
        return "Passport Number may contain only letters and numbers (A–Z, 0–9), no spaces";
    }
    const skip = normalizePassportNumber(skipNumber);
    for (const other of existingNumbers) {
        const n = normalizePassportNumber(other);
        if (n && n === normalized && n !== skip) {
            return "Passport Number must be unique";
        }
    }
    return null;
}

export function validatePassportNationality(value) {
    const nationality = normalizePassportNationality(value);
    if (!nationality) return "Passport Nationality is required";
    if (!NATIONALITY_REGEX.test(nationality)) {
        return "Passport Nationality must be a valid country name";
    }
    return null;
}

export function validatePassportCountryOfIssue(value) {
    const country = normalizePassportCountryOfIssue(value);
    if (!country) return "Country of Issue is required";
    if (!NATIONALITY_REGEX.test(country)) {
        return "Country of Issue must be a valid country name";
    }
    return null;
}

export function validatePassportIssueDate(value) {
    if (!value) return "Issue Date is required";
    const d = parseDate(value);
    if (!d) return "Issue Date must be a valid date";
    if (d.getFullYear() < 1900) return "Issue Date minimum year is 1900";
    const today = startOfDay(new Date());
    if (d > today) return "Issue Date cannot be in the future";
    return null;
}

export function validatePassportExpiryDate(value, issueDate) {
    if (!value) return "Expiry Date is required";
    const expiry = parseDate(value);
    if (!expiry) return "Expiry Date must be a valid date";
    if (expiry.getFullYear() < 1900) return "Expiry Date minimum year is 1900";
    const today = startOfDay(new Date());
    if (expiry <= today) return "Expiry Date must be a future date";
    const issue = parseDate(issueDate);
    if (issue && expiry <= issue) return "Expiry Date must be greater than Issue Date";
    return null;
}

export function normalizeOwnerPassportRow(passport) {
    if (!passport || typeof passport !== "object") return passport;
    const row = { ...passport };
    if (row.number !== undefined) row.number = normalizePassportNumber(row.number);
    if (row.nationality !== undefined) row.nationality = normalizePassportNationality(row.nationality);
    if (row.countryOfIssue !== undefined) row.countryOfIssue = normalizePassportCountryOfIssue(row.countryOfIssue);
    return row;
}

export function validateOwnerPassportRow(passport, { owners = [], ownerIndex = -1 } = {}) {
    if (!passport || typeof passport !== "object") {
        return { ok: true };
    }
    const hasContent =
        passport.number ||
        passport.nationality ||
        passport.countryOfIssue ||
        passport.issueDate ||
        passport.expiryDate ||
        passport.attachment;
    if (!hasContent) return { ok: true };

    const existingNumbers = [];
    owners.forEach((owner, idx) => {
        if (idx === ownerIndex) return;
        const n = owner?.passport?.number;
        if (n) existingNumbers.push(n);
    });

    const checks = [
        validatePassportNumber(passport.number, { existingNumbers }),
        validatePassportNationality(passport.nationality),
        validatePassportIssueDate(passport.issueDate),
        validatePassportExpiryDate(passport.expiryDate, passport.issueDate),
        validatePassportCountryOfIssue(passport.countryOfIssue),
    ];
    for (const err of checks) {
        if (err) return { ok: false, message: err };
    }
    if (!passport.attachment) {
        return { ok: false, message: "Passport Copy is required" };
    }
    return { ok: true };
}

export function validateOwnersPassportPayload(owners = []) {
    if (!Array.isArray(owners)) return { ok: true };
    for (let i = 0; i < owners.length; i++) {
        const check = validateOwnerPassportRow(owners[i]?.passport, { owners, ownerIndex: i });
        if (!check.ok) return check;
    }
    const numbers = new Set();
    for (const owner of owners) {
        const n = normalizePassportNumber(owner?.passport?.number);
        if (!n) continue;
        if (numbers.has(n)) {
            return { ok: false, message: "Passport Number must be unique" };
        }
        numbers.add(n);
    }
    return { ok: true };
}
