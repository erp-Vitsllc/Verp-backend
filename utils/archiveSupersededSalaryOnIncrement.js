import EmployeeSalary from "../models/EmployeeSalary.js";
import { archiveEmployeeDocument } from "./archiveEmployeeDocument.js";
import { purgeEmployeeOldDocuments, PURGE_TYPES } from "./purgeEmployeeOldDocuments.js";

const salaryEntryKey = (entry) => {
    if (entry?._id) return `id:${String(entry._id)}`;
    const fd = entry?.fromDate ? new Date(entry.fromDate).toISOString().slice(0, 10) : "";
    return `from:${fd}:basic:${entry?.basic ?? ""}`;
};

const hasStoredSalaryDocument = (entry) => {
    const doc = entry?.offerLetter || entry?.attachment;
    return Boolean(
        doc &&
            ((typeof doc.url === "string" && doc.url.trim()) ||
                (typeof doc.data === "string" && doc.data.trim())),
    );
};

const formatSalaryPeriod = (entry) => {
    if (entry?.month && String(entry.month).trim()) return String(entry.month).trim();
    const from = entry?.fromDate ? new Date(entry.fromDate) : null;
    if (from && !Number.isNaN(from.getTime())) {
        return from.toLocaleDateString("en-US", { month: "long", year: "numeric" });
    }
    return "Salary";
};

const documentFingerprint = (document) => {
    if (!document || typeof document !== "object") return "";
    const url = typeof document.url === "string" ? document.url.trim() : "";
    if (url) return url;
    const data = typeof document.data === "string" ? document.data.trim() : "";
    return data ? data.slice(0, 120) : "";
};

/**
 * Detect salary increment: an active history row is closed (toDate set) while a new active row exists.
 */
export function detectSupersededSalaryHistoryEntries(previousHistory = [], newHistory = []) {
    const prevList = Array.isArray(previousHistory) ? previousHistory : [];
    const nextList = Array.isArray(newHistory) ? newHistory : [];
    const nextByKey = new Map(nextList.map((entry) => [salaryEntryKey(entry), entry]));

    const superseded = [];
    for (const previous of prevList) {
        const match = nextByKey.get(salaryEntryKey(previous));
        if (!match) continue;
        const wasActive = !previous.toDate;
        const nowClosed = Boolean(match.toDate);
        if (wasActive && nowClosed) {
            superseded.push(match);
        }
    }

    const prevActive = prevList.filter((e) => !e.toDate).length;
    const nextActive = nextList.filter((e) => !e.toDate).length;
    const isIncrement =
        superseded.length > 0 &&
        prevActive >= 1 &&
        nextActive === 1 &&
        nextList.length >= prevList.length;

    return { superseded, isIncrement };
}

const resolveSupersededSalaryDocument = (entry, fallbackOfferLetter = null) => {
    let doc = entry?.offerLetter || entry?.attachment;
    if (hasStoredSalaryDocument({ offerLetter: doc, attachment: doc })) {
        return doc;
    }
    if (hasStoredSalaryDocument({ offerLetter: fallbackOfferLetter })) {
        return fallbackOfferLetter;
    }
    return null;
};

async function archiveSupersededSalaryEntries(employeeId, supersededEntries = [], { fallbackOfferLetter = null } = {}) {
    const archivedFingerprints = new Set();

    for (const entry of supersededEntries) {
        const period = formatSalaryPeriod(entry);
        const resolvedDoc = resolveSupersededSalaryDocument(entry, fallbackOfferLetter);
        const archivePayload = {
            employeeId,
            type: `Previous Salary (${period})`,
            description: `Basic: ${entry.basic ?? 0}, HRA: ${entry.houseRentAllowance ?? 0}, Vehicle: ${entry.vehicleAllowance ?? 0}, Fuel: ${entry.fuelAllowance ?? 0}, Other: ${entry.otherAllowance ?? 0}, Total: ${entry.totalSalary ?? 0}`,
            issueDate: entry.fromDate || null,
            expiryDate: entry.toDate || null,
            basicSalary: entry.basic ?? null,
            houseRentAllowance: entry.houseRentAllowance ?? null,
            vehicleAllowance: entry.vehicleAllowance ?? null,
            fuelAllowance: entry.fuelAllowance ?? null,
            otherAllowance: entry.otherAllowance ?? null,
            totalSalary: entry.totalSalary ?? null,
            document: resolvedDoc || { name: `Previous salary — ${period}`, url: "", mimeType: "application/pdf" },
        };

        const fp = resolvedDoc
            ? documentFingerprint(resolvedDoc)
            : `period:${period}:total:${entry.totalSalary ?? ""}`;
        if (fp && archivedFingerprints.has(fp)) continue;
        if (fp) archivedFingerprints.add(fp);

        await archiveEmployeeDocument(archivePayload);
    }

    return archivedFingerprints;
}

async function archiveTopLevelOfferLetterIfReplaced(employeeId, previousOfferLetter, newOfferLetter) {
    if (!hasStoredSalaryDocument({ offerLetter: previousOfferLetter })) return;
    const prevFp = documentFingerprint(previousOfferLetter);
    const nextFp = documentFingerprint(newOfferLetter);
    if (prevFp && nextFp && prevFp === nextFp) return;

    await archiveEmployeeDocument({
        employeeId,
        type: "Previous Salary (Offer Letter)",
        description: previousOfferLetter?.name || "Superseded salary offer letter",
        document: previousOfferLetter,
    });
}

/**
 * When salary is incremented, archive superseded offer letters to oldDocuments and keep salaryHistory rows closed.
 */
export async function archiveSalaryIncrementIfNeeded(employeeId, proposedData = {}, previousSalary = null) {
    if (!employeeId || !proposedData || !Array.isArray(proposedData.salaryHistory)) {
        return { isIncrement: false, archived: false };
    }

    let prior = previousSalary;
    if (!prior) {
        prior = await EmployeeSalary.findOne({ employeeId })
            .select("salaryHistory offerLetter")
            .lean();
    }

    const { superseded, isIncrement } = detectSupersededSalaryHistoryEntries(
        prior?.salaryHistory || [],
        proposedData.salaryHistory,
    );

    if (!isIncrement) {
        return { isIncrement: false, archived: false };
    }

    const archivedFingerprints = await archiveSupersededSalaryEntries(employeeId, superseded, {
        fallbackOfferLetter: prior?.offerLetter || null,
    });

    if (Object.prototype.hasOwnProperty.call(proposedData, "offerLetter") && prior?.offerLetter) {
        const priorOfferFp = documentFingerprint(prior.offerLetter);
        if (!priorOfferFp || !archivedFingerprints.has(priorOfferFp)) {
            await archiveTopLevelOfferLetterIfReplaced(employeeId, prior.offerLetter, proposedData.offerLetter);
        }
    }

    return { isIncrement: true, archived: true };
}

export async function purgeSalaryOldDocumentsUnlessIncrement(employeeId, { isIncrement = false } = {}) {
    if (isIncrement) return;
    await purgeEmployeeOldDocuments(employeeId, {
        types: PURGE_TYPES.salary,
        purgeDeletedArchiveReason: true,
    });
}
