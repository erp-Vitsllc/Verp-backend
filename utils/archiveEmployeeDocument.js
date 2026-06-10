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
 * Only call from explicit Renew or Not Renew flows — never from edit/add/delete.
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
 * When HR applies a queued renewal change, move the superseded file to oldDocuments.
 * Skipped for regular edits — Old Documents is renew / not-renew only.
 */
const hasStoredDocumentFile = (document) =>
    Boolean(
        document &&
            ((typeof document.url === "string" && document.url.trim() !== "") ||
                (typeof document.data === "string" && document.data.trim() !== "")),
    );

export const employeeDocumentWasSuperseded = (previousData, proposedData) => {
    const prevDoc = previousData?.document;
    if (!hasStoredDocumentFile(prevDoc)) return false;
    const propDoc = proposedData?.document;
    const prevUrl = typeof prevDoc.url === "string" ? prevDoc.url.trim() : "";
    const propUrl = typeof propDoc?.url === "string" ? propDoc.url.trim() : "";
    if (prevUrl && propUrl && prevUrl === propUrl) return false;
    const propData = typeof propDoc?.data === "string" ? propDoc.data.trim() : "";
    if (propData) return true;
    return Boolean(propUrl && (!prevUrl || propUrl !== prevUrl));
};

const SECTION_ARCHIVE_META = {
    passport: {
        type: "Passport",
        description: (data) => (data?.number ? `Passport No: ${data.number}` : ""),
    },
    visa: {
        type: (data, proposedData) => {
            const visaType = String(proposedData?.visaType || "").trim();
            if (!visaType) return "Visa";
            return `${visaType.charAt(0).toUpperCase() + visaType.slice(1)} Visa`;
        },
        description: (data) => (data?.number ? `Visa No: ${data.number}` : ""),
    },
    emiratesid: {
        type: "Emirates ID",
        description: (data) => (data?.number ? `Emirates ID No: ${data.number}` : ""),
    },
    labourcard: {
        type: "Labour Card",
        description: (data) => (data?.number ? `Labour Card No: ${data.number}` : ""),
    },
    medicalinsurance: {
        type: "Medical Insurance",
        description: (data) =>
            data?.number ? `Policy No: ${data.number}` : String(data?.provider || ""),
    },
    drivinglicense: {
        type: "Driving License",
        description: (data) => (data?.number ? `License No: ${data.number}` : ""),
    },
};

export const archiveQueuedPassportOrVisaPreviousIfNeeded = async ({
    employeeId,
    section,
    previousData,
    proposedData,
}) => archiveQueuedEmployeeSectionPreviousIfNeeded({ employeeId, section, previousData, proposedData });

export const archiveQueuedEmployeeSectionPreviousIfNeeded = async ({
    employeeId,
    section,
    previousData,
    proposedData,
    isRenewal = false,
}) => {
    if (isRenewal !== true) return;
    const sec = String(section || "").toLowerCase();
    if (!employeeId || !previousData || typeof previousData !== "object") return;
    if (!employeeDocumentWasSuperseded(previousData, proposedData)) return;

    const meta = SECTION_ARCHIVE_META[sec];
    if (!meta) return;

    const prevDoc = previousData.document;
    const docType = typeof meta.type === "function" ? meta.type(previousData, proposedData) : meta.type;
    if (sec === "visa" && docType === "Visa") return;

    await archiveEmployeeDocument({
        employeeId,
        type: docType,
        description: meta.description(previousData),
        issueDate: previousData.issueDate || null,
        expiryDate: previousData.expiryDate || null,
        document: prevDoc,
    });
};
