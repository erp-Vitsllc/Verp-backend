import mongoose from "mongoose";
import { hasPermission } from "../services/permissionService.js";
import { subdocRowId } from "../services/companyPartitionService.js";
import { shouldOverlayPendingReactivationChanges } from "./companyActivation.js";

export const COMPANY_DELETE_PERM = {
    tradeLicense: "hrm_company_view_basic_trade_license",
    establishment: "hrm_company_view_basic_establishment_card",
    ejari: "hrm_company_view_basic_ejari",
    ownerDetails: "hrm_company_view_owner_details",
    moa: "hrm_company_view_documents_moa",
    memo: "hrm_company_view_documents_memo",
    certificate: "hrm_company_view_documents_certificate",
    docLiveWithExpiry: "hrm_company_view_documents_live_with_expiry",
    docLiveWithoutExpiry: "hrm_company_view_documents_live_without_expiry",
    docLive: "hrm_company_view_documents_live",
    ownerPassport: "hrm_company_view_owner_passport",
    ownerVisa: "hrm_company_view_owner_visa",
    ownerLabourCard: "hrm_company_view_owner_labour_card",
    ownerEmiratesId: "hrm_company_view_owner_emirates_id",
    ownerMedical: "hrm_company_view_owner_medical_insurance",
    ownerDrivingLicense: "hrm_company_view_owner_driving_license",
};

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

export const OWNER_DOC_KEY_PERM = {
    attachment: COMPANY_DELETE_PERM.ownerDetails,
    passport: COMPANY_DELETE_PERM.ownerPassport,
    visa: COMPANY_DELETE_PERM.ownerVisa,
    visitVisa: COMPANY_DELETE_PERM.ownerVisa,
    employmentVisa: COMPANY_DELETE_PERM.ownerVisa,
    spouseVisa: COMPANY_DELETE_PERM.ownerVisa,
    emiratesId: COMPANY_DELETE_PERM.ownerEmiratesId,
    medical: COMPANY_DELETE_PERM.ownerMedical,
    drivingLicense: COMPANY_DELETE_PERM.ownerDrivingLicense,
    labourCard: COMPANY_DELETE_PERM.ownerLabourCard,
};

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

const attachmentUrlsDiffer = (prevUrl, nextUrl) => {
    const a = normalizeAttachmentKeyForCompare(prevUrl || "");
    const b = normalizeAttachmentKeyForCompare(nextUrl || "");
    if (!a || !b) return false;
    return a !== b;
};

const toSerializable = (value) => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    try {
        return JSON.parse(
            JSON.stringify(value, (_k, v) => {
                if (v instanceof mongoose.Types.ObjectId) return String(v);
                if (v instanceof Date) return v.toISOString();
                return v;
            }),
        );
    } catch {
        return value;
    }
};

const collectAttachmentUrls = (items = [], pathKey = "document.url") => {
    const parts = pathKey.split(".");
    const urls = [];
    for (const item of items || []) {
        if (!item || typeof item !== "object") continue;
        let value = item;
        for (const p of parts) value = value?.[p];
        if (typeof value === "string" && value.trim()) urls.push(value.trim());
    }
    return urls;
};

const scalarAttachmentCleared = (beforeVal, afterVal) => {
    const prev =
        typeof beforeVal === "string"
            ? beforeVal.trim()
            : beforeVal?.url?.trim?.() || beforeVal?.url || "";
    const next =
        typeof afterVal === "string"
            ? afterVal.trim()
            : afterVal?.url?.trim?.() || afterVal?.url || "";
    return Boolean(prev) && !next;
};

export const moduleForDocumentContext = (context) => {
    const c = String(context || "").toLowerCase();
    if (c === "moa" || c.includes("moa")) return COMPANY_DELETE_PERM.moa;
    if (c === "memo") return COMPANY_DELETE_PERM.memo;
    if (c === "certificate") return COMPANY_DELETE_PERM.certificate;
    if (c === "document_with_expiry" || c.includes("with_expiry")) {
        return COMPANY_DELETE_PERM.docLiveWithExpiry;
    }
    if (c === "document_without_expiry" || c.includes("without_expiry")) {
        return COMPANY_DELETE_PERM.docLiveWithoutExpiry;
    }
    if (c === "insurance") return COMPANY_DELETE_PERM.docLiveWithExpiry;
    if (c === "ejari") return COMPANY_DELETE_PERM.ejari;
    return COMPANY_DELETE_PERM.docLive;
};

const getOwnerDocAttachmentUrl = (owner, docKey) => {
    if (!owner || typeof owner !== "object") return "";
    if (docKey === "attachment") {
        if (typeof owner.attachment === "string") return owner.attachment.trim();
        return owner.attachment?.url?.trim() || "";
    }
    const doc = owner[docKey];
    if (!doc || typeof doc !== "object") return "";
    if (typeof doc.attachment === "string") return doc.attachment.trim();
    return doc.attachment?.url?.trim() || doc.url?.trim() || "";
};

/** Match owner rows by Mongo _id, then ownerProfileId — not array index. */
const ownerRowMatchKey = (row) => {
    const id = subdocRowId(row);
    if (id) return `id:${id}`;
    const profileId =
        row?.ownerProfileId != null ? String(row.ownerProfileId).trim() : "";
    if (profileId) return `pid:${profileId}`;
    return "";
};

const indexOwnersByMatchKey = (owners = []) => {
    const map = new Map();
    (Array.isArray(owners) ? owners : []).forEach((row, index) => {
        const key = ownerRowMatchKey(row);
        map.set(key || `@idx:${index}`, row);
    });
    return map;
};

const nestedDocAttachmentExplicitlyEmpty = (doc) => {
    if (!doc || typeof doc !== "object") return false;
    if (!Object.prototype.hasOwnProperty.call(doc, "attachment")) return false;
    const att = doc.attachment;
    if (att === null || att === undefined) return false;
    if (typeof att === "string") return att.trim() === "";
    if (typeof att === "object" && att !== null) {
        const url = att.url != null ? String(att.url).trim() : "";
        return url === "";
    }
    return false;
};

/** Row removed by id, owner count drop, or attachment cleared — not array length drift from partial saves. */
const bundleRowsExplicitlyRemoved = (beforeRows = [], afterRows = []) => {
    const before = Array.isArray(beforeRows) ? beforeRows : [];
    const after = Array.isArray(afterRows) ? afterRows : [];
    const afterById = new Map();
    for (const row of after) {
        const id = subdocRowId(row);
        if (id) afterById.set(id, row);
    }

    for (let i = 0; i < before.length; i++) {
        const row = before[i];
        const id = subdocRowId(row);
        if (!id) continue;
        let afterRow = afterById.get(id);
        if (!afterRow && after[i] && subdocRowId(after[i]) === id) {
            afterRow = after[i];
        }
        if (!afterRow && after[i]) {
            afterRow = after[i];
        }
        if (!afterRow && collectAttachmentUrls([row]).length) return true;
        const prevAtt = collectAttachmentUrls([row]);
        const nextAtt = collectAttachmentUrls([afterRow]);
        if (prevAtt.length && !nextAtt.length) return true;
        const prevNorm = prevAtt.map((u) => normalizeAttachmentKeyForCompare(u)).filter(Boolean);
        const nextNorm = nextAtt.map((u) => normalizeAttachmentKeyForCompare(u)).filter(Boolean);
        if (prevNorm.length && nextNorm.length && prevNorm.some((u) => !nextNorm.includes(u))) {
            const hasReplacement = nextNorm.some((u) => !prevNorm.includes(u));
            if (!hasReplacement) return true;
        }
    }

    if (after.length < before.length) {
        const idsRemoved = before.filter((row) => {
            const id = subdocRowId(row);
            return id && !afterById.has(id);
        });
        if (idsRemoved.some((row) => collectAttachmentUrls([row]).length)) return true;
    }

    return false;
};

const ownerSubdocHadCard = (owner, docKey) => {
    if (!owner || typeof owner !== "object") return false;
    if (docKey === "attachment") {
        const att = owner.attachment;
        return att != null && att !== "" && (typeof att !== "string" || att.trim() !== "");
    }
    const doc = owner[docKey];
    if (!doc || typeof doc !== "object") return false;
    if (getOwnerDocAttachmentUrl(owner, docKey)) return true;
    return Boolean(
        String(doc.number || "").trim() ||
            doc.issueDate ||
            doc.expiryDate ||
            String(doc.type || "").trim() ||
            String(doc.provider || "").trim(),
    );
};

const ownerDocExplicitlyCleared = (prevOwner, nextOwner, docKey) => {
    if (!ownerSubdocHadCard(prevOwner, docKey)) return false;

    if (docKey === "attachment") {
        if (!Object.prototype.hasOwnProperty.call(nextOwner, "attachment")) return true;
        const nextVal = nextOwner.attachment;
        if (nextVal === null || nextVal === undefined) return true;
        if (typeof nextVal === "string" && nextVal.trim() === "") return true;
        if (typeof nextVal === "object" && nextVal !== null) {
            const url = nextVal.url != null ? String(nextVal.url).trim() : "";
            return url === "";
        }
        return false;
    }

    if (!Object.prototype.hasOwnProperty.call(nextOwner, docKey)) return true;
    if (nextOwner[docKey] === null || nextOwner[docKey] === undefined) return true;

    const nextDoc = nextOwner[docKey];
    if (!nextDoc || typeof nextDoc !== "object") return true;
    if (!ownerSubdocHadCard(nextOwner, docKey)) return true;
    if (nestedDocAttachmentExplicitlyEmpty(nextDoc)) return true;
    if (!Object.prototype.hasOwnProperty.call(nextDoc, "attachment")) return false;

    return !getOwnerDocAttachmentUrl(nextOwner, docKey);
};

/**
 * Unmistakable delete on an active company (fewer owners, row removed by id, attachment cleared).
 * Normal edits (new file URL, field updates) return false.
 */
export const isExplicitDestructiveCompanyPatch = (beforeCompany = {}, updateData = {}) => {
    if (
        Object.prototype.hasOwnProperty.call(updateData, "tradeLicenseAttachment") &&
        scalarAttachmentCleared(beforeCompany.tradeLicenseAttachment, updateData.tradeLicenseAttachment)
    ) {
        return true;
    }
    if (
        Object.prototype.hasOwnProperty.call(updateData, "establishmentCardAttachment") &&
        scalarAttachmentCleared(
            beforeCompany.establishmentCardAttachment,
            updateData.establishmentCardAttachment,
        )
    ) {
        return true;
    }

    if (Object.prototype.hasOwnProperty.call(updateData, "documents")) {
        if (bundleRowsExplicitlyRemoved(beforeCompany.documents, updateData.documents)) return true;
    }
    if (Object.prototype.hasOwnProperty.call(updateData, "ejari")) {
        if (bundleRowsExplicitlyRemoved(beforeCompany.ejari, updateData.ejari)) return true;
    }
    if (Object.prototype.hasOwnProperty.call(updateData, "insurance")) {
        if (bundleRowsExplicitlyRemoved(beforeCompany.insurance, updateData.insurance)) return true;
    }

    if (Object.prototype.hasOwnProperty.call(updateData, "owners")) {
        const prevByKey = indexOwnersByMatchKey(beforeCompany.owners || []);
        const nextByKey = indexOwnersByMatchKey(updateData.owners || []);

        for (const [key, prevRow] of prevByKey) {
            if (!nextByKey.has(key)) return true;
            const nextRow = nextByKey.get(key);
            for (const docKey of Object.keys(OWNER_DOC_KEY_PERM)) {
                if (ownerDocExplicitlyCleared(prevRow, nextRow, docKey)) return true;
            }
        }
    }

    return false;
};

const collectRemovedDocumentModules = (beforeRows = [], afterRows = []) => {
    const modules = new Set();
    const afterUrlsNormalized = new Set(
        collectAttachmentUrls(afterRows || []).map((u) => normalizeAttachmentKeyForCompare(u)).filter(Boolean)
    );
    const afterIds = new Set();
    for (const r of afterRows || []) {
        const id = subdocRowId(r);
        if (id) afterIds.add(String(id));
    }

    for (const row of beforeRows || []) {
        const rowId = subdocRowId(row);
        const exists = rowId && afterIds.has(String(rowId));

        const urls = collectAttachmentUrls([row]);
        const normalizedUrls = urls.map((u) => normalizeAttachmentKeyForCompare(u)).filter(Boolean);
        const removed = normalizedUrls.some((u) => !afterUrlsNormalized.has(u));

        if (removed || !exists) {
            modules.add(moduleForDocumentContext(row?.context || row?.type));
        }
    }
    return modules;
};

/** Mirrors delete endpoints: group delete is allowed only before full activation. */
export const isCompanyProfileActivated = (company = {}) =>
    shouldOverlayPendingReactivationChanges(company);

export const isDocumentRemovalAttempt = (beforeCompany = {}, updateData = {}) => {
    if (
        Object.prototype.hasOwnProperty.call(updateData, "tradeLicenseAttachment") &&
        scalarAttachmentCleared(beforeCompany.tradeLicenseAttachment, updateData.tradeLicenseAttachment)
    ) {
        return true;
    }
    if (
        Object.prototype.hasOwnProperty.call(updateData, "establishmentCardAttachment") &&
        scalarAttachmentCleared(
            beforeCompany.establishmentCardAttachment,
            updateData.establishmentCardAttachment,
        )
    ) {
        return true;
    }

    if (Object.prototype.hasOwnProperty.call(updateData, "documents")) {
        if (bundleRowsExplicitlyRemoved(beforeCompany.documents, updateData.documents)) return true;
    }

    if (Object.prototype.hasOwnProperty.call(updateData, "ejari")) {
        if (bundleRowsExplicitlyRemoved(beforeCompany.ejari, updateData.ejari)) return true;
    }

    if (Object.prototype.hasOwnProperty.call(updateData, "insurance")) {
        if (bundleRowsExplicitlyRemoved(beforeCompany.insurance, updateData.insurance)) return true;
    }

    if (Object.prototype.hasOwnProperty.call(updateData, "owners")) {
        if (isExplicitDestructiveCompanyPatch(beforeCompany, { owners: updateData.owners })) return true;
    }

    return false;
};

export const collectDeletePermissionModules = (beforeCompany = {}, updateData = {}) => {
    const modules = new Set();

    if (
        Object.prototype.hasOwnProperty.call(updateData, "tradeLicenseAttachment") &&
        scalarAttachmentCleared(beforeCompany.tradeLicenseAttachment, updateData.tradeLicenseAttachment)
    ) {
        modules.add(COMPANY_DELETE_PERM.tradeLicense);
    }
    if (
        Object.prototype.hasOwnProperty.call(updateData, "establishmentCardAttachment") &&
        scalarAttachmentCleared(
            beforeCompany.establishmentCardAttachment,
            updateData.establishmentCardAttachment,
        )
    ) {
        modules.add(COMPANY_DELETE_PERM.establishment);
    }

    if (Object.prototype.hasOwnProperty.call(updateData, "documents")) {
        for (const mod of collectRemovedDocumentModules(
            beforeCompany.documents,
            updateData.documents,
        )) {
            modules.add(mod);
        }
    }

    if (Object.prototype.hasOwnProperty.call(updateData, "ejari")) {
        const prev = beforeCompany.ejari || [];
        const next = updateData.ejari || [];
        const prevUrls = collectAttachmentUrls(prev).map(u => normalizeAttachmentKeyForCompare(u)).filter(Boolean);
        const nextUrls = new Set(collectAttachmentUrls(next).map(u => normalizeAttachmentKeyForCompare(u)).filter(Boolean));
        const urlsRemoved = prevUrls.some(u => !nextUrls.has(u));
        if (prev.length > next.length || urlsRemoved) {
            modules.add(COMPANY_DELETE_PERM.ejari);
        }
    }

    if (Object.prototype.hasOwnProperty.call(updateData, "insurance")) {
        for (const mod of collectRemovedDocumentModules(
            beforeCompany.insurance,
            updateData.insurance,
        )) {
            modules.add(mod);
        }
    }

    if (Object.prototype.hasOwnProperty.call(updateData, "owners")) {
        const prev = beforeCompany.owners || [];
        const next = updateData.owners || [];
        if (next.length < prev.length) {
            modules.add(COMPANY_DELETE_PERM.ownerDetails);
        }
        const prevByKey = indexOwnersByMatchKey(prev);
        const nextByKey = indexOwnersByMatchKey(next);
        for (const [matchKey, prevRow] of prevByKey) {
            const nextRow = nextByKey.get(matchKey);
            if (!nextRow) continue;
            for (const docKey of Object.keys(OWNER_DOC_KEY_PERM)) {
                if (ownerDocExplicitlyCleared(prevRow, nextRow, docKey)) {
                    modules.add(OWNER_DOC_KEY_PERM[docKey] || COMPANY_DELETE_PERM.ownerDetails);
                }
            }
        }
    }

    return [...modules];
};

/**
 * True when the user's group has isDelete on every module touched by this removal.
 * Activated profiles still require admin or the reactivation workflow (not handled here).
 */
export const userMayDeleteCompanyProfileContent = async (user, beforeCompany = {}, updateData = {}) => {
    if (isCompanyProfileActivated(beforeCompany)) {
        return false;
    }

    const userId = user?.id || user?._id?.toString?.() || user?._id;
    if (!userId) return false;

    const modules = collectDeletePermissionModules(beforeCompany, updateData);
    if (modules.length === 0) return false;

    for (const moduleId of modules) {
        if (!(await hasPermission(userId, moduleId, "delete"))) {
            return false;
        }
    }
    return true;
};

/** Inactive company: any authenticated user may clear an owner doc card. */
export const userMayClearOwnerDocumentCard = async (user, beforeCompany = {}) => {
    if (isCompanyProfileActivated(beforeCompany)) {
        return false;
    }
    return Boolean(user?.id || user?._id);
};

/** Active company profiles: admin only. Inactive: any authenticated user. */
export async function denyCompanyCardDeleteUnlessAllowed(req, company = {}) {
    if (!isCompanyProfileActivated(company)) return null;
    const { isReqUserAdmin } = await import("./sendAdminDeletionNotificationEmails.js");
    const isAdmin = await isReqUserAdmin(req.user);
    if (!isAdmin) {
        return {
            status: 403,
            body: { message: "Only administrator can delete cards on an active company profile." },
        };
    }
    return null;
}

export const userMayCompactDeleteCompanyContent = async (
    user,
    beforeCompany = {},
    { pullDocumentsByIds = [], pullOldDocumentsByIds = [], pullOwnersByIds = [] } = {},
) => {
    if (isCompanyProfileActivated(beforeCompany)) {
        return false;
    }

    const userId = user?.id || user?._id?.toString?.() || user?._id;
    if (!userId) return false;

    const modules = new Set();
    if (pullOwnersByIds.length) {
        modules.add(COMPANY_DELETE_PERM.ownerDetails);
    }
    if (pullDocumentsByIds.length) {
        modules.add(COMPANY_DELETE_PERM.docLive);
    }
    if (pullOldDocumentsByIds.length) {
        modules.add("hrm_company_view_documents_old");
    }

    if (modules.size === 0) return false;

    for (const moduleId of modules) {
        if (!(await hasPermission(userId, moduleId, "delete"))) {
            return false;
        }
    }
    return true;
};
