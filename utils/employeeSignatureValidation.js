const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILENAME_LENGTH = 255;
const ALLOWED_MIME = new Set(["image/jpeg", "image/jpg", "image/png"]);
const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png"]);
const BLOCKED_EXT = new Set([".exe", ".bat", ".cmd", ".apk", ".msi", ".sh", ".ps1", ".com", ".scr"]);

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

export function validateEmployeeSignaturePayload({
    signatureData,
    fileName = "",
    signedAt,
    dateOfJoining = "",
} = {}) {
    if (!signatureData) return { ok: false, message: "Signature image is required" };

    const mime =
        typeof signatureData === "string" && signatureData.startsWith("data:")
            ? signatureData.substring(5, signatureData.indexOf(";base64,")).toLowerCase()
            : String(signatureData?.mimeType || "").toLowerCase();

    const name = String(fileName || "").toLowerCase();
    const ext = name.includes(".") ? `.${name.split(".").pop()}` : "";

    if (mime === "application/pdf" || ext === ".pdf") {
        return { ok: false, message: "Only JPG, JPEG, and PNG formats are allowed" };
    }
    if (BLOCKED_EXT.has(ext)) return { ok: false, message: "Executable files are not allowed" };
    if (mime && !ALLOWED_MIME.has(mime) && ext && !ALLOWED_EXT.has(ext)) {
        return { ok: false, message: "Only JPG, JPEG, and PNG formats are allowed" };
    }
    if (name.length > MAX_FILENAME_LENGTH) {
        return { ok: false, message: "File name must be no more than 255 characters" };
    }

    if (!signedAt) return { ok: false, message: "Signed date is required" };
    const signed = parseDate(signedAt);
    if (!signed) return { ok: false, message: "Signed date must be a valid date" };
    if (startOfDay(signed) > startOfDay(new Date())) {
        return { ok: false, message: "Signed date cannot be in the future" };
    }
    const joined = parseDate(dateOfJoining);
    if (joined && startOfDay(signed) < startOfDay(joined)) {
        return { ok: false, message: "Signed date cannot be earlier than Date of Joining" };
    }

  // Rough size check for base64 payloads (~4/3 of bytes)
    if (typeof signatureData === "string" && signatureData.includes("base64,")) {
        const b64 = signatureData.split("base64,")[1] || "";
        const approxBytes = Math.floor((b64.length * 3) / 4);
        if (approxBytes > MAX_FILE_BYTES) return { ok: false, message: "File size must be less than 5MB" };
    }

    return { ok: true };
}
