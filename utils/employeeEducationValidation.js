import { stripDangerousText } from "./employeeAddValidation.js";

const LETTERS_SPACES = /^[A-Za-z\s]+$/;

function validateOptionalInstitution(value, label) {
    const cleaned = stripDangerousText(value).replace(/\s+/g, " ").trim();
    if (!cleaned) return null;
    if (cleaned.length > 150) return `${label} must be no more than 150 characters`;
    if (!LETTERS_SPACES.test(cleaned)) return `${label} must contain only letters and spaces`;
    return null;
}

function validateRequiredText(value, label, { min = 2, max = 100 } = {}) {
    const cleaned = stripDangerousText(value).replace(/\s+/g, " ").trim();
    if (!cleaned) return `${label} is required`;
    if (cleaned.length < min) return `${label} must be at least ${min} characters`;
    if (cleaned.length > max) return `${label} must be no more than ${max} characters`;
    if (!LETTERS_SPACES.test(cleaned)) return `${label} must contain only letters and spaces`;
    return null;
}

function validateCompletedYear(value) {
    const cleaned = String(value ?? "").trim();
    if (!cleaned) return "Completed Year is required";
    if (!/^\d{4}$/.test(cleaned)) return "Completed Year must be exactly 4 digits (YYYY)";
    const year = parseInt(cleaned, 10);
    const currentYear = new Date().getFullYear();
    if (year < 1900 || year > currentYear) {
        return `Completed Year must be between 1900 and ${currentYear}`;
    }
    return null;
}

function validateCertificateAttachment(certificate, { requireFile = true, hasExisting = false } = {}) {
    const hasCert = Boolean(
        certificate?.url ||
        certificate?.data ||
        (certificate?.name && hasExisting),
    );
    if (!hasCert) {
        return requireFile && !hasExisting ? "Certificate is required" : null;
    }
    const name = String(certificate?.name || "").toLowerCase();
    const mime = String(certificate?.mimeType || "").toLowerCase();
    if (mime && mime !== "application/pdf" && !name.endsWith(".pdf")) {
        return "Only PDF files are allowed";
    }
    if (!mime && name && !name.endsWith(".pdf")) {
        return "Only PDF files are allowed";
    }
    return null;
}

export function validateEmployeeEducationPayload(body = {}, options = {}) {
    const { requireCertificate = true, hasExistingCertificate = false } = options;
    const errors = [];
    const push = (err) => {
        if (err) errors.push(err);
    };

    push(validateOptionalInstitution(body.universityOrBoard, "University / Board"));
    push(validateOptionalInstitution(body.collegeOrInstitute, "College / Institute"));
    push(validateRequiredText(body.course, "Course"));
    push(validateRequiredText(body.fieldOfStudy, "Field of Study"));
    push(validateCompletedYear(body.completedYear));
    push(
        validateCertificateAttachment(body.certificate, {
            requireFile: requireCertificate,
            hasExisting: hasExistingCertificate,
        }),
    );

    return { ok: errors.length === 0, errors, message: errors[0] || "" };
}
