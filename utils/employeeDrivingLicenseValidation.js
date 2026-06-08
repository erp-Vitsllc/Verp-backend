import EmployeeDrivingLicense from "../models/EmployeeDrivingLicense.js";

const LICENSE_NUMBER_REGEX = /^[A-Za-z0-9]{3,50}$/;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

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

function normalizeNumber(value) {
    return String(value || "").replace(/\s/g, "").trim();
}

function validateNumber(value, { existingNumbers = [], skipNumber = "" } = {}) {
    const number = normalizeNumber(value);
    if (!number) return "Driving license number is required";
    if (number.length < 3) return "Driving license number must be at least 3 characters";
    if (number.length > 50) return "Driving license number must be no more than 50 characters";
    if (!LICENSE_NUMBER_REGEX.test(number)) {
        return "Driving license number may contain only letters and numbers";
    }
    const skip = normalizeNumber(skipNumber);
    for (const other of existingNumbers) {
        const n = normalizeNumber(other);
        if (n && n === number && n !== skip) {
            return "Driving license number must be unique";
        }
    }
    return null;
}

function validateIssueDate(value) {
    if (!value) return "Issue date is required";
    const d = parseDate(value);
    if (!d) return "Issue date must be a valid date";
    const today = startOfDay(new Date());
    if (startOfDay(d) > today) return "Issue date cannot be in the future";
    return null;
}

function validateExpiryDate(expiryDate, issueDate) {
    if (!expiryDate) return "Expiry date is required";
    const expiry = parseDate(expiryDate);
    if (!expiry) return "Expiry date must be a valid date";
    const issue = parseDate(issueDate);
    if (issue && startOfDay(expiry) <= startOfDay(issue)) {
        return "Expiry date must be later than the issue date";
    }
    return null;
}

function validateAttachment(document, fileName) {
    const hasDoc = Boolean(
        document?.url || document?.data || document?.publicId ||
        (typeof document === "string" && document.trim()),
    );
    if (!hasDoc) return "Driving license document is required";
    const mime = String(document?.mimeType || "").toLowerCase();
    if (mime && mime !== "application/pdf") return "Only PDF file format is allowed";
    const name = String(fileName || document?.name || "").toLowerCase();
    if (name && !name.endsWith(".pdf")) return "Only PDF file format is allowed";
    return null;
}

export async function collectDrivingLicenseNumbers({ skipEmployeeId = "" } = {}) {
    const rows = await EmployeeDrivingLicense.find({
        employeeId: { $ne: skipEmployeeId },
        "drivingLicenceDetails.number": { $exists: true, $ne: "" },
    })
        .select("drivingLicenceDetails.number")
        .lean();
    return rows.map((r) => r?.drivingLicenceDetails?.number).filter(Boolean);
}

export function normalizeEmployeeDrivingLicensePayload(payload = {}) {
    return {
        ...payload,
        number: payload.number !== undefined ? normalizeNumber(payload.number) : payload.number,
    };
}

export async function validateEmployeeDrivingLicensePayload(
    payload = {},
    { employeeId = "", existingLicenseNumber = "" } = {},
) {
    const existingNumbers = await collectDrivingLicenseNumbers({ skipEmployeeId: employeeId });
    const checks = [
        validateNumber(payload.number, { existingNumbers, skipNumber: existingLicenseNumber }),
        validateIssueDate(payload.issueDate),
        validateExpiryDate(payload.expiryDate, payload.issueDate),
        validateAttachment(payload.document, payload.documentName),
    ];
    for (const err of checks) {
        if (err) return { ok: false, message: err };
    }
    return { ok: true };
}

export { MAX_FILE_BYTES };
