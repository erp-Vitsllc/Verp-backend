import { stripDangerousText } from "./employeeAddValidation.js";

const COMPANY_DESIGNATION = /^[A-Za-z0-9\s]+$/;
const ALLOWED_EXPERIENCE_MIMES = ["application/pdf", "image/jpeg", "image/jpg", "image/png"];

function parseDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

function validateCompanyOrDesignation(value, label) {
    const cleaned = stripDangerousText(value).replace(/\s+/g, " ").trim();
    if (!cleaned) return `${label} is required`;
    if (cleaned.length < 2) return `${label} must be at least 2 characters`;
    const max = label === "Company" ? 150 : 100;
    if (cleaned.length > max) return `${label} must be no more than ${max} characters`;
    if (!COMPANY_DESIGNATION.test(cleaned)) {
        return `${label} must contain only letters, numbers, and spaces`;
    }
    return null;
}

function validateStartDate(value) {
    if (!value) return "Start Date is required";
    const d = parseDate(value);
    if (!d) return "Start Date must be a valid date";
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    if (d > today) return "Start Date cannot be in the future";
    return null;
}

function validateEndDate(value, startDate) {
    if (!value) return "End Date is required";
    const end = parseDate(value);
    if (!end) return "End Date must be a valid date";
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    if (end > today) return "End Date cannot be in the future";
    if (startDate) {
        const start = parseDate(startDate);
        if (start) {
            start.setHours(0, 0, 0, 0);
            end.setHours(0, 0, 0, 0);
            if (end <= start) return "End Date must be after Start Date";
        }
    }
    return null;
}

function validateCertificateAttachment(certificate, { requireFile = true, hasExisting = false } = {}) {
    const hasCert = Boolean(certificate?.url || certificate?.data || (certificate?.name && hasExisting));
    if (!hasCert) {
        return requireFile && !hasExisting ? "Certificate is required" : null;
    }
    const name = String(certificate?.name || "").toLowerCase();
    const mime = String(certificate?.mimeType || "").toLowerCase();
    const ext = name.split(".").pop();
    const allowedExt = ["pdf", "jpg", "jpeg", "png"];
    if (name && !allowedExt.includes(ext)) return "Certificate must be PDF, JPEG, or PNG";
    if (mime && !ALLOWED_EXPERIENCE_MIMES.includes(mime)) {
        return "Certificate must be PDF, JPEG, or PNG";
    }
    return null;
}

export function validateEmployeeExperiencePayload(body = {}, options = {}) {
    const { requireCertificate = true, hasExistingCertificate = false } = options;
    const errors = [];
    const push = (err) => {
        if (err) errors.push(err);
    };

    push(validateCompanyOrDesignation(body.company, "Company"));
    push(validateCompanyOrDesignation(body.designation, "Designation"));
    push(validateStartDate(body.startDate));
    push(validateEndDate(body.endDate, body.startDate));
    push(
        validateCertificateAttachment(body.certificate, {
            requireFile: requireCertificate,
            hasExisting: hasExistingCertificate,
        }),
    );

    return { ok: errors.length === 0, errors, message: errors[0] || "" };
}
