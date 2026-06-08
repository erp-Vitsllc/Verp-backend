const BANK_NAME_REGEX = /^[A-Za-z\s]{2,100}$/;
const ACCOUNT_NAME_REGEX = /^[A-Za-z\s'-]{2,100}$/;
const ACCOUNT_NUMBER_REGEX = /^\d{5,30}$/;
const IBAN_REGEX = /^[A-Z]{2}\d{2}[A-Z0-9]{4,30}$/i;
const SWIFT_REGEX = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/;

function stripDangerousText(value) {
    if (value === undefined || value === null) return "";
    let str = String(value).trim();
    str = str.replace(/<[^>]*>?/gm, "");
    if (/<|>|javascript:|on\w+=/i.test(str)) return "";
    return str;
}

function normalizeSpaces(value) {
    return String(value ?? "").trim().replace(/\s+/g, " ");
}

function validateBankName(value) {
    const cleaned = normalizeSpaces(value);
    if (!cleaned) return "Bank Name is required";
    if (!BANK_NAME_REGEX.test(cleaned)) return "Bank name must contain only letters and spaces (2-100 characters)";
    return null;
}

function validateAccountName(value) {
    const cleaned = normalizeSpaces(value);
    if (!cleaned) return "Account Name is required";
    if (!ACCOUNT_NAME_REGEX.test(cleaned)) {
        return "Account name may contain only letters, spaces, apostrophe (') and hyphen (-)";
    }
    return null;
}

function validateAccountNumber(value) {
    const cleaned = String(value ?? "").trim();
    if (!cleaned) return "Account Number is required";
    if (!ACCOUNT_NUMBER_REGEX.test(cleaned)) {
        return "Account number must be 5-30 digits with numbers only";
    }
    return null;
}

function validateIban(value) {
    const cleaned = String(value ?? "").replace(/\s/g, "").toUpperCase();
    if (!cleaned) return "IBAN Number is required";
    if (cleaned.length < 15 || cleaned.length > 34) return "IBAN must be between 15 and 34 characters";
    if (!IBAN_REGEX.test(cleaned)) return "Please enter a valid IBAN format";
    return null;
}

function validateSwift(value) {
    const cleaned = String(value ?? "").replace(/\s/g, "").toUpperCase();
    if (!cleaned) return null;
    if (cleaned.length !== 8 && cleaned.length !== 11) return "SWIFT code must be 8 or 11 characters";
    if (!SWIFT_REGEX.test(cleaned)) return "Please enter a valid SWIFT code format";
    return null;
}

function validateOtherDetails(value) {
    const cleaned = stripDangerousText(value);
    if (!cleaned) return null;
    if (cleaned.length > 500) return "Other details must be no more than 500 characters";
    return null;
}

function validateBankAttachment(attachment) {
    if (!attachment) return "Bank attachment is required";
    const hasDoc = Boolean(
        attachment?.url ||
        attachment?.data ||
        (typeof attachment === "string" && attachment.trim()),
    );
    if (!hasDoc) return "Bank attachment is required";
    return null;
}

export function validateEmployeeBankPayload(payload = {}, { requireAttachment = true } = {}) {
    const errors = [];
    const checks = [
        validateBankName(payload.bankName ?? payload.bank),
        validateAccountName(payload.accountName ?? payload.bankAccountName),
        validateAccountNumber(payload.accountNumber ?? payload.bankAccountNumber),
        validateIban(payload.ibanNumber),
        validateSwift(payload.swiftCode ?? payload.ifscCode),
        validateOtherDetails(payload.bankOtherDetails ?? payload.otherBankDetails),
    ];
    checks.forEach((err) => {
        if (err) errors.push(err);
    });
    if (requireAttachment) {
        const attachErr = validateBankAttachment(payload.bankAttachment);
        if (attachErr) errors.push(attachErr);
    }
    return errors;
}
