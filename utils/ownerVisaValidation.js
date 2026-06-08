const VISA_NUMBER_REGEX = /^[A-Za-z0-9]{5,20}$/;

export function stripDangerousText(value) {
    if (value === undefined || value === null) return "";
    if (typeof value === "object" || Array.isArray(value)) {
        throw new Error("Invalid data type for visa field");
    }
    let str = String(value).trim();
    str = str.replace(/<[^>]*>?/gm, "");
    return str;
}

export function normalizeVisaNumber(value) {
    return stripDangerousText(value).replace(/\s/g, "");
}

export function normalizeVisaSponsor(value) {
    return stripDangerousText(value);
}

export function normalizeVisaTypeLabel(value) {
    const t = stripDangerousText(value).toLowerCase();
    if (t === "visit" || t === "visiting") return "Visit";
    if (t === "employment") return "Employment";
    if (t === "spouse") return "Spouse";
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

export function validateVisaNumber(value, { requireUnique = false, existingNumbers = [], skipNumber = "" } = {}) {
    const normalized = normalizeVisaNumber(value);
    if (!normalized) return "Visa Number is required";
    if (normalized.length < 5) return "Visa Number must be at least 5 characters";
    if (normalized.length > 20) return "Visa Number must be no more than 20 characters";
    if (!VISA_NUMBER_REGEX.test(normalized)) {
        return "Visa Number may contain only letters and numbers (A–Z, a–z, 0–9)";
    }
    if (requireUnique) {
        const skip = normalizeVisaNumber(skipNumber);
        for (const other of existingNumbers) {
            const n = normalizeVisaNumber(other);
            if (n && n === normalized && n !== skip) {
                return "Visa Number must be unique";
            }
        }
    }
    return null;
}

export function validateVisaIssueDate(value) {
    if (!value) return "Issue Date is required";
    const d = parseDate(value);
    if (!d) return "Issue Date must be a valid date";
    if (d.getFullYear() < 1900) return "Issue Date minimum year is 1900";
    const today = startOfDay(new Date());
    if (d > today) return "Issue Date cannot be in the future";
    return null;
}

export function validateVisaExpiryDate(value, issueDate) {
    if (!value) return "Expiry Date is required";
    const expiry = parseDate(value);
    if (!expiry) return "Expiry Date must be a valid date";
    if (expiry.getFullYear() < 1900) return "Expiry Date minimum year is 1900";
    const issue = parseDate(issueDate);
    if (issue && expiry <= issue) return "Expiry Date must be greater than Issue Date";
    return null;
}

export function validateVisaSponsor(value) {
    const sponsor = normalizeVisaSponsor(value);
    if (!sponsor) return "Visa Sponsor is required";
    if (sponsor.length < 2) return "Visa Sponsor must be at least 2 characters";
    if (sponsor.length > 100) return "Visa Sponsor must be no more than 100 characters";
    return null;
}

function collectEmploymentVisaNumbers(owners = [], { skipOwnerIndex = -1 } = {}) {
    const numbers = [];
    owners.forEach((owner, idx) => {
        if (idx === skipOwnerIndex) return;
        const n = owner?.employmentVisa?.number;
        if (n) numbers.push(n);
        const legacyType = normalizeVisaTypeLabel(owner?.visa?.type).toLowerCase();
        if (legacyType === "employment" && owner?.visa?.number) {
            numbers.push(owner.visa.number);
        }
    });
    return numbers;
}

export function normalizeOwnerVisaRow(visa) {
    if (!visa || typeof visa !== "object") return visa;
    const row = { ...visa };
    if (row.number !== undefined) row.number = normalizeVisaNumber(row.number);
    if (row.sponsor !== undefined) row.sponsor = normalizeVisaSponsor(row.sponsor);
    if (row.type !== undefined) row.type = normalizeVisaTypeLabel(row.type);
    return row;
}

export function validateOwnerVisaRow(visa, { visaDocKey = "visitVisa", owners = [], ownerIndex = -1 } = {}) {
    if (!visa || typeof visa !== "object") {
        return { ok: true };
    }
    const hasContent =
        visa.number || visa.issueDate || visa.expiryDate || visa.sponsor || visa.attachment;
    if (!hasContent) return { ok: true };

    const requireUnique = visaDocKey === "employmentVisa";
    const existingNumbers = requireUnique
        ? collectEmploymentVisaNumbers(owners, { skipOwnerIndex: ownerIndex })
        : [];

    const checks = [
        validateVisaNumber(visa.number, {
            requireUnique,
            existingNumbers,
            skipNumber: owners[ownerIndex]?.[visaDocKey]?.number || "",
        }),
        validateVisaIssueDate(visa.issueDate),
        validateVisaExpiryDate(visa.expiryDate, visa.issueDate),
    ];
    if (visaDocKey === "employmentVisa" || visaDocKey === "spouseVisa") {
        checks.push(validateVisaSponsor(visa.sponsor));
    }
    for (const err of checks) {
        if (err) return { ok: false, message: err };
    }
    if (!visa.attachment) {
        return { ok: false, message: "Visa document is required" };
    }
    return { ok: true };
}

export function validateOwnersVisaPayload(owners = []) {
    if (!Array.isArray(owners)) return { ok: true };
    const visaKeys = ["visitVisa", "employmentVisa", "spouseVisa"];
    for (let i = 0; i < owners.length; i++) {
        for (const key of visaKeys) {
            const check = validateOwnerVisaRow(owners[i]?.[key], {
                visaDocKey: key,
                owners,
                ownerIndex: i,
            });
            if (!check.ok) return check;
        }
        const legacy = owners[i]?.visa;
        if (legacy && typeof legacy === "object") {
            const legacyType = normalizeVisaTypeLabel(legacy.type).toLowerCase();
            const mappedKey =
                legacyType === "visit"
                    ? "visitVisa"
                    : legacyType === "employment"
                      ? "employmentVisa"
                      : legacyType === "spouse"
                        ? "spouseVisa"
                        : null;
            if (mappedKey) {
                const check = validateOwnerVisaRow(legacy, {
                    visaDocKey: mappedKey,
                    owners,
                    ownerIndex: i,
                });
                if (!check.ok) return check;
            }
        }
    }
    const employmentNumbers = new Set();
    for (const owner of owners) {
        const n = normalizeVisaNumber(owner?.employmentVisa?.number);
        if (!n) continue;
        if (employmentNumbers.has(n)) {
            return { ok: false, message: "Visa Number must be unique" };
        }
        employmentNumbers.add(n);
    }
    return { ok: true };
}
