import EmployeeEmiratesId from "../models/EmployeeEmiratesId.js";
import {
    normalizeEmiratesIdNumber,
    validateEmiratesIdNumber,
    validateEmiratesIdIssueDate,
    validateEmiratesIdExpiryDate,
} from "./ownerEmiratesIdValidation.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

function validateEmiratesIdAttachment(document, fileName) {
    const hasDoc = Boolean(
        document?.url ||
        document?.data ||
        document?.publicId ||
        (typeof document === "string" && document.trim()),
    );
    if (!hasDoc) return "Emirates ID document is required";
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

export async function collectEmployeeEmiratesIdNumbers({ skipEmployeeId = "" } = {}) {
    const rows = await EmployeeEmiratesId.find({
        employeeId: { $ne: skipEmployeeId },
        "emiratesId.number": { $exists: true, $ne: "" },
    })
        .select("emiratesId.number")
        .lean();
    return rows.map((r) => r?.emiratesId?.number).filter(Boolean);
}

export function normalizeEmployeeEmiratesIdPayload(payload = {}) {
    return {
        ...payload,
        number: payload.number !== undefined ? normalizeEmiratesIdNumber(payload.number) : payload.number,
    };
}

export async function validateEmployeeEmiratesIdPayload(
    payload = {},
    { employeeId = "", existingEmiratesIdNumber = "" } = {},
) {
    const existingNumbers = await collectEmployeeEmiratesIdNumbers({ skipEmployeeId: employeeId });

    const checks = [
        validateEmiratesIdNumber(payload.number, {
            existingNumbers,
            skipNumber: existingEmiratesIdNumber,
        }),
        validateEmiratesIdIssueDate(payload.issueDate),
        validateEmiratesIdExpiryDate(payload.expiryDate, payload.issueDate),
        validateEmiratesIdAttachment(payload.document, payload.documentName),
    ];

    for (const err of checks) {
        if (err) return { ok: false, message: err };
    }
    return { ok: true };
}

export { MAX_FILE_BYTES };
