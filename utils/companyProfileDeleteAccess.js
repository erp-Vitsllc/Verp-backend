import mongoose from "mongoose";
import { hasPermission } from "../services/permissionService.js";
import {
    ownersChangeIsVisaDocsOnly,
    shouldOverlayPendingReactivationChanges,
} from "./companyActivation.js";

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

const OWNER_DOC_KEY_PERM = {
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

const moduleForDocumentContext = (context) => {
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

const collectRemovedDocumentModules = (beforeRows = [], afterRows = []) => {
    const modules = new Set();
    const afterByUrl = new Set(collectAttachmentUrls(afterRows));
    for (const row of beforeRows || []) {
        const urls = collectAttachmentUrls([row]);
        const removed = urls.some((u) => !afterByUrl.has(u));
        if (removed || !afterRows.includes(row)) {
            modules.add(moduleForDocumentContext(row?.context || row?.type));
        }
    }
    if ((beforeRows || []).length > (afterRows || []).length) {
        for (const row of beforeRows || []) {
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
        scalarAttachmentCleared(beforeCompany.tradeLicenseAttachment, updateData.tradeLicenseAttachment)
    ) {
        return true;
    }
    if (
        scalarAttachmentCleared(
            beforeCompany.establishmentCardAttachment,
            updateData.establishmentCardAttachment,
        )
    ) {
        return true;
    }

    if (Object.prototype.hasOwnProperty.call(updateData, "documents")) {
        const prevUrls = new Set(collectAttachmentUrls(beforeCompany.documents));
        const nextUrls = new Set(collectAttachmentUrls(updateData.documents));
        for (const u of prevUrls) {
            if (!nextUrls.has(u)) return true;
        }
        if ((beforeCompany.documents || []).length > (updateData.documents || []).length) {
            return true;
        }
    }

    if (Object.prototype.hasOwnProperty.call(updateData, "ejari")) {
        const prevUrls = new Set(collectAttachmentUrls(beforeCompany.ejari));
        const nextUrls = new Set(collectAttachmentUrls(updateData.ejari));
        for (const u of prevUrls) {
            if (!nextUrls.has(u)) return true;
        }
        if ((beforeCompany.ejari || []).length > (updateData.ejari || []).length) {
            return true;
        }
    }

    if (Object.prototype.hasOwnProperty.call(updateData, "insurance")) {
        const prevUrls = new Set(collectAttachmentUrls(beforeCompany.insurance));
        const nextUrls = new Set(collectAttachmentUrls(updateData.insurance));
        for (const u of prevUrls) {
            if (!nextUrls.has(u)) return true;
        }
        if ((beforeCompany.insurance || []).length > (updateData.insurance || []).length) {
            return true;
        }
    }

    if (Object.prototype.hasOwnProperty.call(updateData, "owners")) {
        const prev = beforeCompany.owners || [];
        const next = updateData.owners || [];
        if (next.length < prev.length) return true;
        if (ownersChangeIsVisaDocsOnly(prev, next)) return false;
        try {
            const prevJson = JSON.stringify(toSerializable(prev));
            const nextJson = JSON.stringify(toSerializable(next));
            if (prevJson !== nextJson) {
                const ownerDocKeys = Object.keys(OWNER_DOC_KEY_PERM);
                for (let i = 0; i < Math.max(prev.length, next.length); i += 1) {
                    const p = prev[i] || {};
                    const n = next[i] || {};
                    for (const key of ownerDocKeys) {
                        const pUrl =
                            key === "attachment"
                                ? typeof p.attachment === "string"
                                    ? p.attachment
                                    : p.attachment?.url
                                : p[key]?.attachment?.url || p[key]?.attachment;
                        const nUrl =
                            key === "attachment"
                                ? typeof n.attachment === "string"
                                    ? n.attachment
                                    : n.attachment?.url
                                : n[key]?.attachment?.url || n[key]?.attachment;
                        if (pUrl && !nUrl) return true;
                        if (pUrl && nUrl && attachmentUrlsDiffer(pUrl, nUrl)) return true;
                    }
                }
            }
        } catch {
            return true;
        }
    }

    return false;
};

export const collectDeletePermissionModules = (beforeCompany = {}, updateData = {}) => {
    const modules = new Set();

    if (
        scalarAttachmentCleared(beforeCompany.tradeLicenseAttachment, updateData.tradeLicenseAttachment)
    ) {
        modules.add(COMPANY_DELETE_PERM.tradeLicense);
    }
    if (
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
        if (prev.length > next.length || collectAttachmentUrls(prev).some((u) => !collectAttachmentUrls(next).includes(u))) {
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
        } else if (!ownersChangeIsVisaDocsOnly(prev, next)) {
            const ownerDocKeys = Object.keys(OWNER_DOC_KEY_PERM);
            for (let i = 0; i < Math.max(prev.length, next.length); i += 1) {
                const p = prev[i] || {};
                const n = next[i] || {};
                for (const key of ownerDocKeys) {
                    const pUrl =
                        key === "attachment"
                            ? typeof p.attachment === "string"
                                ? p.attachment
                                : p.attachment?.url
                            : p[key]?.attachment?.url || p[key]?.attachment;
                    const nUrl =
                        key === "attachment"
                            ? typeof n.attachment === "string"
                                ? n.attachment
                                : n.attachment?.url
                            : n[key]?.attachment?.url || n[key]?.attachment;
                    if ((pUrl && !nUrl) || (pUrl && nUrl && attachmentUrlsDiffer(pUrl, nUrl))) {
                        modules.add(OWNER_DOC_KEY_PERM[key] || COMPANY_DELETE_PERM.ownerDetails);
                    }
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
