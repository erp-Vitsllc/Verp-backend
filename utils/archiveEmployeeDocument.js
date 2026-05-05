import EmployeeBasic from "../models/EmployeeBasic.js";

const documentStorageFingerprint = (document) => {
    if (!document || typeof document !== "object") return "";
    const url = typeof document.url === "string" ? document.url.trim() : "";
    if (url) return `url:${url}`;
    const data = typeof document.data === "string" ? document.data.trim() : "";
    if (data) return `data:${data.slice(0, 200)}`;
    return "";
};

/**
 * Skip pushing if the same file was already archived as "Replaced" (concurrent renews / double apply).
 */
const isDuplicateReplacedArchive = async (employeeId, type, document) => {
    const fp = documentStorageFingerprint(document);
    if (!fp) return false;
    const basic = await EmployeeBasic.findOne({ employeeId }).select("oldDocuments").lean();
    const list = Array.isArray(basic?.oldDocuments) ? basic.oldDocuments : [];
    return list.some(
        (d) =>
            String(d?.archiveReason || "") === "Replaced" &&
            String(d?.type || "") === String(type || "") &&
            documentStorageFingerprint(d?.document) === fp,
    );
};

/**
 * Archive a replaced system/manual document into EmployeeBasic.oldDocuments.
 * This keeps old versions visible in Documents > Old Documents.
 */
export const archiveEmployeeDocument = async ({
    employeeId,
    type,
    description = "",
    issueDate = null,
    expiryDate = null,
    cost = null,
    basicSalary = null,
    houseRentAllowance = null,
    vehicleAllowance = null,
    fuelAllowance = null,
    otherAllowance = null,
    totalSalary = null,
    document,
}) => {
    if (!employeeId || !document) return;

    if (await isDuplicateReplacedArchive(employeeId, type || "Document", document)) {
        return;
    }

    await EmployeeBasic.updateOne(
        { employeeId },
        {
            $push: {
                oldDocuments: {
                    type: type || "Document",
                    description,
                    issueDate: issueDate || null,
                    expiryDate: expiryDate || null,
                    cost: cost ?? null,
                    basicSalary: basicSalary ?? null,
                    houseRentAllowance: houseRentAllowance ?? null,
                    vehicleAllowance: vehicleAllowance ?? null,
                    fuelAllowance: fuelAllowance ?? null,
                    otherAllowance: otherAllowance ?? null,
                    totalSalary: totalSalary ?? null,
                    createdAt: new Date(),
                    archivedAt: new Date(),
                    archiveReason: "Replaced",
                    document,
                },
            },
        }
    );
};

/**
 * When HR applies a queued passport/visa change, move the superseded file to oldDocuments.
 * Live PATCH skips archiving while profile edits are queued (see updatePassportDetails / updateVisaDetails).
 */
export const archiveQueuedPassportOrVisaPreviousIfNeeded = async ({ employeeId, section, previousData, proposedData }) => {
    const sec = String(section || "").toLowerCase();
    if (!employeeId || !previousData || typeof previousData !== "object") return;

    const prevDoc = previousData.document;
    const hasPrevFile = Boolean(
        prevDoc &&
            ((typeof prevDoc.url === "string" && prevDoc.url.trim() !== "") ||
                (typeof prevDoc.data === "string" && prevDoc.data.trim() !== "")),
    );
    if (!hasPrevFile) return;

    const propDoc = proposedData?.document;
    const prevUrl = typeof prevDoc.url === "string" ? prevDoc.url.trim() : "";
    const propUrl = typeof propDoc?.url === "string" ? propDoc.url.trim() : "";
    const sameUrl = prevUrl && propUrl && prevUrl === propUrl;
    if (sameUrl) return;

    if (sec === "passport") {
        await archiveEmployeeDocument({
            employeeId,
            type: "Passport",
            description: previousData.number ? `Passport No: ${previousData.number}` : "",
            issueDate: previousData.issueDate || null,
            expiryDate: previousData.expiryDate || null,
            document: prevDoc,
        });
        return;
    }

    if (sec === "visa") {
        const visaType = String(proposedData?.visaType || "").trim();
        if (!visaType) return;
        await archiveEmployeeDocument({
            employeeId,
            type: `${visaType.charAt(0).toUpperCase() + visaType.slice(1)} Visa`,
            description: previousData.number ? `Visa No: ${previousData.number}` : "",
            issueDate: previousData.issueDate || null,
            expiryDate: previousData.expiryDate || null,
            document: prevDoc,
        });
    }
};
