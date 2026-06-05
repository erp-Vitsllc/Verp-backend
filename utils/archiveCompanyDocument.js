import Company from "../models/Company.js";
import CompanyDocumentBundle from "../models/CompanyDocumentBundle.js";

const isCompanyUsingPartitions = (core = {}) => Number(core.dataPartitionVersion) >= 1;

const normalizeCompanyMongoId = (companyMongoId) =>
    companyMongoId?._id != null ? companyMongoId._id : companyMongoId;

/** Old Documents tab reads `CompanyDocumentBundle.oldDocuments` for partitioned companies. */
const loadAuthoritativeOldDocuments = async (companyId) => {
    const id = normalizeCompanyMongoId(companyId);
    const core = await Company.findById(id).select("dataPartitionVersion").lean();
    if (!isCompanyUsingPartitions(core || {})) {
        const company = await Company.findById(id).select("oldDocuments").lean();
        return Array.isArray(company?.oldDocuments) ? company.oldDocuments : [];
    }
    const bundle = await CompanyDocumentBundle.findOne({ company: id }).select("oldDocuments").lean();
    return Array.isArray(bundle?.oldDocuments) ? bundle.oldDocuments : [];
};

const pushArchivedRowToOldDocuments = async (companyId, archivedRow) => {
    const id = normalizeCompanyMongoId(companyId);
    const core = await Company.findById(id).select("dataPartitionVersion").lean();
    const bundleExists = await CompanyDocumentBundle.exists({ company: id });
    const useBundle = isCompanyUsingPartitions(core || {}) || bundleExists;

    if (useBundle) {
        await CompanyDocumentBundle.findOneAndUpdate(
            { company: id },
            {
                $push: { oldDocuments: archivedRow },
                $setOnInsert: {
                    company: id,
                    documents: [],
                    insurance: [],
                    ejari: [],
                    trainingDetails: [],
                    customTabs: [],
                    hasLiveMoa: false,
                },
            },
            { upsert: true },
        );
        return;
    }

    await Company.updateOne({ _id: id }, { $push: { oldDocuments: archivedRow } });
};

/** Same logic as updateCompany.js — signed URLs vs stored keys must compare equal. */
const FOLDER_MARKERS = [
    "company-documents",
    "employee-documents",
    "asset-invoices",
    "asset-photos",
    "profile-pictures",
    "signatures",
    "rewards",
    "fines",
];

const normalizeAttachmentKeyForCompare = (value) => {
    if (typeof value !== "string" || !value.trim()) return "";
    const noQuery = value.split("?")[0].trim();
    const lower = noQuery.toLowerCase();
    for (const folder of FOLDER_MARKERS) {
        const idx = lower.indexOf(folder);
        if (idx !== -1) return noQuery.slice(idx).toLowerCase();
    }
    return noQuery.toLowerCase();
};

const documentStorageFingerprint = (urlOrObj) => {
    if (!urlOrObj) return "";
    if (typeof urlOrObj === "string") return `url:${normalizeAttachmentKeyForCompare(urlOrObj)}`;
    if (typeof urlOrObj.url === "string") return `url:${normalizeAttachmentKeyForCompare(urlOrObj.url)}`;
    return "";
};

const attachmentUrlsDiffer = (prevUrl, nextUrl) => {
    const a = normalizeAttachmentKeyForCompare(prevUrl || "");
    const b = normalizeAttachmentKeyForCompare(nextUrl || "");
    if (!a || !b) return false;
    return a !== b;
};

const normalizeDocumentDateForCompare = (value) => {
    if (value == null || value === "") return "";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? String(value).trim() : parsed.toISOString().slice(0, 10);
};

const documentDatesChanged = (prev, next) =>
    normalizeDocumentDateForCompare(prev?.issueDate) !== normalizeDocumentDateForCompare(next?.issueDate) ||
    normalizeDocumentDateForCompare(prev?.expiryDate) !== normalizeDocumentDateForCompare(next?.expiryDate);

/**
 * Skip pushing if the same file was already archived as "Replaced" (concurrent renews / double apply).
 */
const isDuplicateReplacedArchive = async (companyId, type, document) => {
    const fp = documentStorageFingerprint(document);
    if (!fp) return false;
    const list = await loadAuthoritativeOldDocuments(companyId);
    return list.some(
        (d) =>
            String(d?.archiveReason || "") === "Replaced" &&
            String(d?.type || "") === String(type || "") &&
            documentStorageFingerprint(d?.document) === fp,
    );
};

/**
 * Archive a replaced company document into Company.oldDocuments.
 */
export const archiveCompanyDocument = async ({
    companyId,
    type,
    description = "",
    issueDate = null,
    expiryDate = null,
    cost = null,
    document, // can be string (URL) or { url, name, mimeType }
    context = "",
    provider = "",
}) => {
    if (!companyId || !document) return;

    if (await isDuplicateReplacedArchive(companyId, type || "Document", document)) {
        return;
    }

    const docObj = typeof document === "string" ? { url: document } : document;

    const archivedRow = {
        type: type || "Document",
        description,
        issueDate: issueDate || null,
        expiryDate: expiryDate || null,
        cost: cost ?? null,
        archivedAt: new Date(),
        archiveReason: "Replaced",
        document: docObj,
    };
    if (context) archivedRow.context = context;
    if (provider) archivedRow.provider = provider;

    await pushArchivedRowToOldDocuments(companyId, archivedRow);
};

/**
 * Compare before/after state and archive any documents that were replaced.
 */
export const archiveSupersededCompanyDocuments = async (beforeCompany, updateData) => {
    if (!beforeCompany || !updateData) return;
    const companyId = beforeCompany._id;

    const checkAndArchive = async (key, type, label) => {
        const prev = beforeCompany[key];
        const next = updateData[key];
        // For Company, some attachments are strings (URL), some are objects.
        const prevUrl = typeof prev === "string" ? prev.trim() : prev?.url?.trim();
        const nextUrl = typeof next === "string" ? next.trim() : next?.url?.trim();

        if (prevUrl && nextUrl && attachmentUrlsDiffer(prevUrl, nextUrl)) {
            await archiveCompanyDocument({
                companyId,
                type,
                description: `${label} (superseded)`,
                issueDate: beforeCompany[`${key}IssueDate`] || null,
                expiryDate: beforeCompany[`${key}Expiry`] || beforeCompany[`${key}ExpiryDate`] || null,
                document: prev,
            });
        }
    };

    // 1. Trade License
    await checkAndArchive("tradeLicenseAttachment", "Trade License", "Trade License");

    // 2. Establishment Card
    await checkAndArchive("establishmentCardAttachment", "Establishment Card", "Establishment Card");

    // 3. Ejari (Array)
    if (Array.isArray(beforeCompany.ejari) && Array.isArray(updateData.ejari)) {
        const archivedEjariIds = new Set();
        for (const nextEjari of updateData.ejari) {
            if (!nextEjari._id || !nextEjari.document?.url) continue;
            const idStr = String(nextEjari._id);
            if (archivedEjariIds.has(idStr)) continue;
            const prevEjari = beforeCompany.ejari.find(ej => String(ej._id) === String(nextEjari._id));
            if (prevEjari && prevEjari.document?.url && attachmentUrlsDiffer(prevEjari.document.url, nextEjari.document.url)) {
                archivedEjariIds.add(idStr);
                await archiveCompanyDocument({
                    companyId,
                    type: prevEjari.type ? `Ejari - ${prevEjari.type}` : "Ejari",
                    description: prevEjari.description || "Ejari / Tenancy Contract (superseded)",
                    issueDate: prevEjari.issueDate || null,
                    expiryDate: prevEjari.expiryDate || null,
                    document: prevEjari.document,
                });
            }
        }
    }

    // 4. Insurance (Array)
    if (Array.isArray(beforeCompany.insurance) && Array.isArray(updateData.insurance)) {
        const archivedInsuranceIds = new Set();
        for (const nextIns of updateData.insurance) {
            if (!nextIns._id || !nextIns.document?.url) continue;
            const idStr = String(nextIns._id);
            if (archivedInsuranceIds.has(idStr)) continue;
            const prevIns = beforeCompany.insurance.find(ins => String(ins._id) === String(nextIns._id));
            if (prevIns && prevIns.document?.url && attachmentUrlsDiffer(prevIns.document.url, nextIns.document.url)) {
                archivedInsuranceIds.add(idStr);
                await archiveCompanyDocument({
                    companyId,
                    type: prevIns.type ? `Insurance - ${prevIns.type}` : "Insurance",
                    description: prevIns.description || "Company Insurance (superseded)",
                    issueDate: prevIns.issueDate || null,
                    expiryDate: prevIns.expiryDate || null,
                    document: prevIns.document,
                });
            }
        }
    }

    // 5. Custom Documents array
    if (Array.isArray(beforeCompany.documents) && Array.isArray(updateData.documents)) {
        const archivedCustomDocIds = new Set();
        for (const nextDoc of updateData.documents) {
            if (!nextDoc._id || !nextDoc.document?.url) continue;
            const idStr = String(nextDoc._id);
            if (archivedCustomDocIds.has(idStr)) continue;
            const prevDoc = beforeCompany.documents.find(d => String(d._id) === String(nextDoc._id));
            if (
                prevDoc &&
                prevDoc.document?.url &&
                (attachmentUrlsDiffer(prevDoc.document.url, nextDoc.document.url) ||
                    documentDatesChanged(prevDoc, nextDoc))
            ) {
                archivedCustomDocIds.add(idStr);
                await archiveCompanyDocument({
                    companyId,
                    type: prevDoc.type || "Document",
                    description: prevDoc.description || "Company document (superseded)",
                    issueDate: prevDoc.issueDate || null,
                    expiryDate: prevDoc.expiryDate || null,
                    document: prevDoc.document,
                    context: prevDoc.context || "",
                    provider: prevDoc.provider || "",
                });
            }
        }
    }

    // 6. Owners
    if (Array.isArray(beforeCompany.owners) && Array.isArray(updateData.owners)) {
        for (const nextOwner of updateData.owners) {
            if (!nextOwner._id) continue;
            const prevOwner = beforeCompany.owners.find(o => String(o._id) === String(nextOwner._id));
            if (!prevOwner) continue;

            const checkOwnerDoc = async (key, typeLabel) => {
                const prev = prevOwner[key]?.attachment;
                const next = nextOwner[key]?.attachment;
                const prevUrl = prev?.url?.trim();
                const nextUrl = next?.url?.trim();
                if (prevUrl && nextUrl && attachmentUrlsDiffer(prevUrl, nextUrl)) {
                    await archiveCompanyDocument({
                        companyId,
                        type: `Owner ${typeLabel}`,
                        description: `Owner: ${prevOwner.name} - ${typeLabel} (superseded)`,
                        issueDate: prevOwner[key]?.issueDate || null,
                        expiryDate: prevOwner[key]?.expiryDate || null,
                        document: prev,
                    });
                }
            };

            await checkOwnerDoc("passport", "Passport");
            await checkOwnerDoc("visa", "Visa");
            await checkOwnerDoc("emiratesId", "Emirates ID");
        }
    }
};
