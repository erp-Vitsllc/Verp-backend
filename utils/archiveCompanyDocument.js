import Company from "../models/Company.js";
import CompanyDocumentBundle from "../models/CompanyDocumentBundle.js";
import { mergeCompanyOwnersSnapshot, OWNER_NESTED_DOC_KEYS } from "./mergeCompanyOwnersSnapshot.js";

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

const resolveAttachmentUrl = (att) => {
    if (att == null || att === "") return "";
    if (typeof att === "string") return att.trim();
    if (typeof att === "object" && att.url) return String(att.url).trim();
    return "";
};

const nestedOwnerDocHasLiveContent = (doc) => {
    if (!doc || typeof doc !== "object") return false;
    const scalarKeys = ["number", "nationality", "type", "provider", "issueDate", "expiryDate", "sponsor"];
    if (scalarKeys.some((k) => doc[k] != null && String(doc[k]).trim() !== "")) return true;
    return Boolean(resolveAttachmentUrl(doc.attachment));
};

const ownerNestedDocSuperseded = (prevDoc, nextDoc) => {
    if (!nestedOwnerDocHasLiveContent(prevDoc)) return false;
    const prevAtt = resolveAttachmentUrl(prevDoc?.attachment);
    const nextAtt = resolveAttachmentUrl(nextDoc?.attachment);
    if (prevAtt && nextAtt && attachmentUrlsDiffer(prevAtt, nextAtt)) return true;
    if (documentDatesChanged(prevDoc, nextDoc || {})) return true;
    const prevNum = String(prevDoc?.number || "").trim();
    const nextNum = String(nextDoc?.number || "").trim();
    if (prevNum && nextNum && prevNum !== nextNum) return true;
    return false;
};

const OWNER_NESTED_DOC_LABELS = {
    passport: "Passport",
    emiratesId: "Emirates ID",
    visa: "Visa",
    visitVisa: "Visit Visa",
    employmentVisa: "Employment Visa",
    spouseVisa: "Spouse Visa",
    labourCard: "Labour Card",
    medical: "Medical Insurance",
    drivingLicense: "Driving License",
};

const findPrevOwnerRow = (mergedRow, beforeOwners = []) => {
    if (mergedRow?._id != null) {
        const hit = beforeOwners.find((b) => String(b?._id) === String(mergedRow._id));
        if (hit) return hit;
    }
    const profileId = mergedRow?.ownerProfileId;
    if (profileId != null && String(profileId).trim() !== "") {
        const hit = beforeOwners.find(
            (b) => b?.ownerProfileId != null && String(b.ownerProfileId) === String(profileId),
        );
        if (hit) return hit;
    }
    return null;
};

const arrayDocumentSuperseded = (prevRow, nextRow) => {
    if (!prevRow || !nextRow) return false;
    const prevUrl = resolveAttachmentUrl(prevRow.document);
    const nextUrl = resolveAttachmentUrl(nextRow.document);
    if (prevUrl && nextUrl && attachmentUrlsDiffer(prevUrl, nextUrl)) return true;
    return documentDatesChanged(prevRow, nextRow);
};

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

    const checkAndArchiveCompliance = async (
        attachmentKey,
        type,
        label,
        { issueDateKey = null, expiryDateKey = null, numberKey = null } = {},
    ) => {
        const prevAtt = resolveAttachmentUrl(beforeCompany[attachmentKey]);
        if (!prevAtt) return;

        const nextAtt = Object.prototype.hasOwnProperty.call(updateData, attachmentKey)
            ? resolveAttachmentUrl(updateData[attachmentKey])
            : prevAtt;

        let superseded = false;
        if (nextAtt && attachmentUrlsDiffer(prevAtt, nextAtt)) {
            superseded = true;
        }
        if (!superseded) {
            if (
                numberKey &&
                Object.prototype.hasOwnProperty.call(updateData, numberKey) &&
                String(beforeCompany[numberKey] || "").trim() !== String(updateData[numberKey] || "").trim()
            ) {
                superseded = true;
            }
            if (
                issueDateKey &&
                Object.prototype.hasOwnProperty.call(updateData, issueDateKey) &&
                normalizeDocumentDateForCompare(beforeCompany[issueDateKey]) !==
                    normalizeDocumentDateForCompare(updateData[issueDateKey])
            ) {
                superseded = true;
            }
            if (
                expiryDateKey &&
                Object.prototype.hasOwnProperty.call(updateData, expiryDateKey) &&
                normalizeDocumentDateForCompare(beforeCompany[expiryDateKey]) !==
                    normalizeDocumentDateForCompare(updateData[expiryDateKey])
            ) {
                superseded = true;
            }
        }

        if (!superseded) return;

        await archiveCompanyDocument({
            companyId,
            type,
            description: `${label} (superseded)`,
            issueDate: issueDateKey ? beforeCompany[issueDateKey] || null : null,
            expiryDate: expiryDateKey
                ? beforeCompany[expiryDateKey] || beforeCompany[`${attachmentKey}ExpiryDate`] || null
                : null,
            document: beforeCompany[attachmentKey],
            context:
                attachmentKey === "tradeLicenseAttachment"
                    ? "trade_license"
                    : attachmentKey === "establishmentCardAttachment"
                      ? "establishment_card"
                      : "",
        });
    };

    await checkAndArchiveCompliance("tradeLicenseAttachment", "Trade License", "Trade License", {
        issueDateKey: "tradeLicenseIssueDate",
        expiryDateKey: "tradeLicenseExpiry",
        numberKey: "tradeLicenseNumber",
    });

    await checkAndArchiveCompliance(
        "establishmentCardAttachment",
        "Establishment Card",
        "Establishment Card",
        {
            issueDateKey: "establishmentCardIssueDate",
            expiryDateKey: "establishmentCardExpiry",
            numberKey: "establishmentCardNumber",
        },
    );

    const archiveArrayReplacements = async (field, typePrefix, defaultDescription) => {
        if (!Array.isArray(beforeCompany[field]) || !Array.isArray(updateData[field])) return;
        const archivedIds = new Set();
        for (const nextRow of updateData[field]) {
            if (!nextRow?._id) continue;
            const idStr = String(nextRow._id);
            if (archivedIds.has(idStr)) continue;
            const prevRow = beforeCompany[field].find((row) => String(row._id) === idStr);
            if (!prevRow || !arrayDocumentSuperseded(prevRow, nextRow)) continue;
            archivedIds.add(idStr);
            const rowType = prevRow.type ? `${typePrefix} - ${prevRow.type}` : typePrefix;
            await archiveCompanyDocument({
                companyId,
                type: rowType,
                description: prevRow.description || `${defaultDescription} (superseded)`,
                issueDate: prevRow.issueDate || null,
                expiryDate: prevRow.expiryDate || null,
                document: prevRow.document,
                context: field === "ejari" ? "ejari" : field === "insurance" ? "insurance" : prevRow.context || "",
                provider: prevRow.provider || "",
            });
        }
    };

    await archiveArrayReplacements("ejari", "Ejari", "Ejari / Tenancy Contract");
    await archiveArrayReplacements("insurance", "Insurance", "Company Insurance");

    if (Array.isArray(beforeCompany.documents) && Array.isArray(updateData.documents)) {
        const archivedCustomDocIds = new Set();
        for (const nextDoc of updateData.documents) {
            if (!nextDoc._id) continue;
            const idStr = String(nextDoc._id);
            if (archivedCustomDocIds.has(idStr)) continue;
            const prevDoc = beforeCompany.documents.find((d) => String(d._id) === idStr);
            if (!prevDoc || !arrayDocumentSuperseded(prevDoc, nextDoc)) continue;
            if (String(prevDoc.context || "").toLowerCase() === "certificate") continue;
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

    if (Array.isArray(beforeCompany.owners) && Array.isArray(updateData.owners)) {
        const mergedOwners = mergeCompanyOwnersSnapshot(beforeCompany.owners, updateData.owners);
        const archivedOwnerDocKeys = new Set();

        for (const mergedRow of mergedOwners) {
            const prevOwner = findPrevOwnerRow(mergedRow, beforeCompany.owners);
            if (!prevOwner) continue;
            const ownerName = String(prevOwner.name || mergedRow.name || "Owner").trim() || "Owner";

            for (const docKey of OWNER_NESTED_DOC_KEYS) {
                const prevDoc = prevOwner[docKey];
                const nextDoc = mergedRow[docKey];
                if (!ownerNestedDocSuperseded(prevDoc, nextDoc)) continue;

                const dedupeKey = `${String(prevOwner._id || prevOwner.ownerProfileId || ownerName)}::${docKey}::${resolveAttachmentUrl(prevDoc?.attachment)}`;
                if (archivedOwnerDocKeys.has(dedupeKey)) continue;
                archivedOwnerDocKeys.add(dedupeKey);

                const typeLabel = OWNER_NESTED_DOC_LABELS[docKey] || docKey;
                await archiveCompanyDocument({
                    companyId,
                    // Match not-renew archives: UI Old Documents parses `${ownerName} - ${docLabel}` from `type`.
                    type: `${ownerName} - ${typeLabel}`,
                    description: `${typeLabel} (superseded)`,
                    issueDate: prevDoc?.issueDate || null,
                    expiryDate: prevDoc?.expiryDate || null,
                    document: prevDoc?.attachment
                        ? typeof prevDoc.attachment === "string"
                            ? { url: prevDoc.attachment, mimeType: "application/pdf" }
                            : prevDoc.attachment
                        : null,
                    context: "owner_doc",
                });
            }
        }
    }
};
