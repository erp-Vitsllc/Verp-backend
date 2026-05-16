import EmployeeBasic from "../models/EmployeeBasic.js";

export const documentStorageFingerprint = (document) => {
    if (!document || typeof document !== "object") return "";
    const url = typeof document.url === "string" ? document.url.trim() : "";
    if (url) return `url:${url}`;
    const data = typeof document.data === "string" ? document.data.trim() : "";
    if (data) return `data:${data.slice(0, 200)}`;
    return "";
};

const normType = (value) => String(value || "").trim().toLowerCase();

const rowMatchesType = (rowType, typeNorms) => {
    if (!typeNorms.length) return false;
    return typeNorms.some(
        (t) => rowType === t || rowType.includes(t) || t.includes(rowType),
    );
};

/**
 * Remove archived rows after an admin hard-delete so nothing remains in Old Documents.
 */
export async function purgeEmployeeOldDocuments(
    employeeId,
    { types = [], documentFingerprints = [], purgeDeletedArchiveReason = false } = {},
) {
    if (!employeeId) return { removed: 0 };

    const employee = await EmployeeBasic.findOne({ employeeId }).select("oldDocuments");
    if (!employee?.oldDocuments?.length) return { removed: 0 };

    const typeNorms = [...new Set((types || []).map(normType).filter(Boolean))];
    const fpSet = new Set((documentFingerprints || []).filter(Boolean));

    const before = employee.oldDocuments.length;
    employee.oldDocuments = employee.oldDocuments.filter((row) => {
        const rowType = normType(row?.type);
        const rowReason = String(row?.archiveReason || "");
        const rowFp = documentStorageFingerprint(row?.document);

        if (
            purgeDeletedArchiveReason &&
            rowReason === "Deleted" &&
            rowMatchesType(rowType, typeNorms)
        ) {
            return false;
        }

        if (rowMatchesType(rowType, typeNorms)) {
            return false;
        }

        if (fpSet.size && rowFp && fpSet.has(rowFp)) {
            return false;
        }

        return true;
    });

    if (employee.oldDocuments.length !== before) {
        employee.markModified("oldDocuments");
        await employee.save();
    }

    return { removed: before - employee.oldDocuments.length };
}

export const PURGE_TYPES = {
    passport: ["passport"],
    emirates: ["emirates id"],
    medical: ["medical insurance"],
    driving: ["driving license"],
    labourCard: ["labour card", "labour contract"],
    bank: ["bank attachment", "bank details", "bank"],
    salary: ["salary", "current salary", "salary offer letter", "salary increment letter"],
    signature: ["digital signature", "signature"],
    training: ["training"],
    visa: (visaType) => [`${String(visaType || "").trim().toLowerCase()} visa`],
};
