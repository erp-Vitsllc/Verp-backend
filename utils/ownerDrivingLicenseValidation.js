const LICENSE_NUMBER_REGEX = /^[A-Za-z0-9]{5,20}$/;

export function stripDangerousText(value) {
    if (value === undefined || value === null) return "";
    if (typeof value === "object" || Array.isArray(value)) {
        throw new Error("Invalid data type for Driving License field");
    }
    let str = String(value).trim();
    str = str.replace(/<[^>]*>?/gm, "");
    return str;
}

export function normalizeDrivingLicenseNumber(value) {
    return stripDangerousText(value).replace(/\s/g, "");
}

export function normalizeIssuingCountry(value) {
    return stripDangerousText(value).replace(/\s+/g, " ").trim();
}

function parseDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

export function validateDrivingLicenseNumber(value) {
    const normalized = normalizeDrivingLicenseNumber(value);
    if (!normalized) return "License Number is required";
    if (normalized.length < 5) return "License Number must be at least 5 characters";
    if (normalized.length > 20) return "License Number must be no more than 20 characters";
    if (!LICENSE_NUMBER_REGEX.test(normalized)) {
        return "License Number may contain only letters and numbers (A–Z, a–z, 0–9)";
    }
    return null;
}

export function validateDrivingLicenseIssueDate(value) {
    if (!value) return "Issue Date is required";
    const d = parseDate(value);
    if (!d) return "Issue Date must be a valid date";
    if (d.getFullYear() < 1900) return "Issue Date minimum year is 1900";
    return null;
}

export function validateDrivingLicenseExpiryDate(value, issueDate) {
    if (!value) return "Expiry Date is required";
    const expiry = parseDate(value);
    if (!expiry) return "Expiry Date must be a valid date";
    if (expiry.getFullYear() < 1900) return "Expiry Date minimum year is 1900";
    const issue = parseDate(issueDate);
    if (issue && expiry <= issue) return "Expiry Date must be greater than Issue Date";
    return null;
}

export function validateIssuingCountry(value) {
    const normalized = normalizeIssuingCountry(value);
    if (!normalized) return "Issuing Country is required";
    if (normalized.length < 2) return "Issuing Country must be at least 2 characters";
    if (normalized.length > 100) return "Issuing Country must be no more than 100 characters";
    return null;
}

export function normalizeOwnerDrivingLicenseRow(drivingLicense) {
    if (!drivingLicense || typeof drivingLicense !== "object") return drivingLicense;
    const row = { ...drivingLicense };
    if (row.number !== undefined) row.number = normalizeDrivingLicenseNumber(row.number);
    if (row.issuingCountry !== undefined) row.issuingCountry = normalizeIssuingCountry(row.issuingCountry);
    return row;
}

export function validateOwnerDrivingLicenseRow(drivingLicense) {
    if (!drivingLicense || typeof drivingLicense !== "object") {
        return { ok: true };
    }
    const hasContent =
        drivingLicense.number ||
        drivingLicense.issueDate ||
        drivingLicense.expiryDate ||
        drivingLicense.issuingCountry ||
        drivingLicense.attachment;
    if (!hasContent) return { ok: true };

    const checks = [
        validateDrivingLicenseNumber(drivingLicense.number),
        validateDrivingLicenseIssueDate(drivingLicense.issueDate),
        validateDrivingLicenseExpiryDate(drivingLicense.expiryDate, drivingLicense.issueDate),
        validateIssuingCountry(drivingLicense.issuingCountry),
    ];
    for (const err of checks) {
        if (err) return { ok: false, message: err };
    }
    if (!drivingLicense.attachment) {
        return { ok: false, message: "Driving License document is required" };
    }
    return { ok: true };
}

export function validateOwnersDrivingLicensePayload(owners = []) {
    if (!Array.isArray(owners)) return { ok: true };
    for (const owner of owners) {
        const check = validateOwnerDrivingLicenseRow(owner?.drivingLicense);
        if (!check.ok) return check;
    }
    return { ok: true };
}
