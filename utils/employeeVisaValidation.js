import EmployeeVisa from "../models/EmployeeVisa.js";
import {
    normalizeVisaNumber,
    normalizeVisaSponsor,
    validateVisaNumber,
    validateVisaExpiryDate,
    validateVisaSponsor,
} from "./ownerVisaValidation.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

function parseDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

function validateEmployeeVisaIssueDate(value) {
    if (!value) return "Issue date is required";
    const d = parseDate(value);
    if (!d) return "Issue date must be a valid date";
    if (d.getFullYear() < 1900) return "Issue date minimum year is 1900";
    return null;
}

function validateVisaAttachment(document, fileName) {
    const hasDoc = Boolean(
        document?.url ||
        document?.data ||
        document?.publicId ||
        (typeof document === "string" && document.trim()),
    );
    if (!hasDoc) return "Visa copy is required";
    const mime = String(document?.mimeType || "").toLowerCase();
    if (mime && mime !== "application/pdf") {
        return "Only PDF file format is allowed";
    }
    const name = String(fileName || document?.name || "").toLowerCase();
    if (name && !name.endsWith(".pdf")) {
        return "Only PDF file format is allowed";
    }
    return null;
}

export async function collectEmploymentVisaNumbers({ skipEmployeeId = "" } = {}) {
    const rows = await EmployeeVisa.find({
        employeeId: { $ne: skipEmployeeId },
        "employment.number": { $exists: true, $ne: "" },
    })
        .select("employment.number")
        .lean();
    return rows.map((r) => r?.employment?.number).filter(Boolean);
}

export function normalizeEmployeeVisaPayload(payload = {}, visaType = "visit") {
    const normalized = {
        ...payload,
        number: payload.number !== undefined ? normalizeVisaNumber(payload.number) : payload.number,
    };
    if (visaType === "employment" || visaType === "spouse") {
        normalized.sponsor =
            payload.sponsor !== undefined ? normalizeVisaSponsor(payload.sponsor) : payload.sponsor;
    }
    return normalized;
}

export async function validateEmployeeVisaPayload(
    payload = {},
    { visaType = "visit", employeeId = "", existingVisaNumber = "" } = {},
) {
    const existingEmploymentNumbers =
        visaType === "employment" ? await collectEmploymentVisaNumbers({ skipEmployeeId: employeeId }) : [];

    const checks = [
        validateVisaNumber(payload.number, {
            requireUnique: visaType === "employment",
            existingNumbers: existingEmploymentNumbers,
            skipNumber: existingVisaNumber,
        }),
        validateEmployeeVisaIssueDate(payload.issueDate),
        validateVisaExpiryDate(payload.expiryDate, payload.issueDate),
    ];

    if (visaType === "employment" || visaType === "spouse") {
        checks.push(validateVisaSponsor(payload.sponsor));
    }
    checks.push(validateVisaAttachment(payload.document, payload.documentName));

    for (const err of checks) {
        if (err) return { ok: false, message: err };
    }
    return { ok: true };
}

export { MAX_FILE_BYTES };
