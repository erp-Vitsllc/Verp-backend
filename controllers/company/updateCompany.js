import mongoose from "mongoose";
import Company from "../../models/Company.js";
import CompanyCompliance from "../../models/CompanyCompliance.js";
import DashboardAction from "../../models/DashboardAction.js";
import {
    loadCompanyFullProfile,
    upsertCompanyPartitions,
    companyPendingEntryId,
    splitCompanyUpdatePayload,
    DOCUMENT_BUNDLE_KEYS,
    clearOwnerDocInPartition,
    findOwnerRow,
} from "../../services/companyPartitionService.js";
import { archiveSupersededCompanyDocuments } from "../../utils/archiveCompanyDocument.js";
import { archiveSupersededCompanyOwners } from "../../utils/archiveCompanyOwners.js";
import { syncDashboardAction } from "../../utils/syncDashboard.js";
import { sendResponsibilityApprovalEmail } from "../../utils/sendResponsibilityApprovalEmail.js";
import { buildResponsibilityEmailData } from "../../utils/flowchartResponsibilityEmailData.js";
import { getSignedFileUrl } from "../../utils/s3Upload.js";
import {
    calculateCompanyActivationProgress,
    shouldTriggerCompanyReactivation,
    collectCompanyReactivationChangeLabels,
    pickCompanyPendingPreviousSnapshot,
    stripProposedDataKeysFromPendingReactivationEntries,
    isCompanyFullyActivated,
} from "../../utils/companyActivation.js";
import {
    markCompanyActivationHoldResolvedForUpdate,
    labelsRequiredForActivationHoldEntry,
} from "../../utils/markCompanyActivationHoldResolved.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";
import { isRequestUserDesignatedFlowchartHr } from "../../utils/isDesignatedFlowchartHr.js";
import {
    normalizeCompanyUpdateAttachments,
    signCompanyDocumentArray,
} from "../../utils/signCompanyDocumentFields.js";
import { reconcileCompanyDocumentExpiryDashboard } from "../../utils/processDocumentExpiryReminders.js";
import {
    closeCreatorNotRenewFollowUpTasks,
    closeCreatorNotRenewFollowUpsFromCompanyUpdate,
} from "../../utils/companyNotRenewFollowUp.js";
import {
    sanitizeCompanyAddressField,
    validateCompanyAddressPayload,
} from "../../utils/companyAddressValidation.js";
import {
    normalizeTradeLicenseNumber,
    normalizeTradeLicenseOwners,
    validateTradeLicensePayload,
    validateTradeLicenseOwnersPayload,
} from "../../utils/tradeLicenseValidation.js";
import {
    normalizeEstablishmentCardNumber,
    validateEstablishmentCardPayload,
    validateEstablishmentCardExpiryDate,
} from "../../utils/establishmentCardValidation.js";
import { normalizeEjariRow, validateEjariArrayPayload } from "../../utils/ejariValidation.js";
import {
    normalizeOwnerDetailsRow,
    validateOwnerDetailsOwnersPayload,
} from "../../utils/ownerDetailsValidation.js";
import { collectGlobalOwnerProfileIds } from "../../utils/ownerProfileId.js";
import {
    normalizeOwnerPassportRow,
    validateOwnersPassportPayload,
} from "../../utils/ownerPassportValidation.js";
import {
    normalizeOwnerEmiratesIdRow,
    validateOwnersEmiratesIdPayload,
} from "../../utils/ownerEmiratesIdValidation.js";
import {
    normalizeOwnerVisaRow,
    validateOwnersVisaPayload,
} from "../../utils/ownerVisaValidation.js";
import {
    normalizeOwnerLabourCardRow,
    validateOwnersLabourCardPayload,
} from "../../utils/ownerLabourCardValidation.js";
import {
    normalizeOwnerMedicalInsuranceRow,
    validateOwnersMedicalInsurancePayload,
} from "../../utils/ownerMedicalInsuranceValidation.js";
import {
    normalizeOwnerDrivingLicenseRow,
    validateOwnersDrivingLicensePayload,
} from "../../utils/ownerDrivingLicenseValidation.js";
import {
    validateCompanyCertificateDocumentsPayload,
    normalizeCompanyCertificateRow,
} from "../../utils/companyCertificateValidation.js";
import {
    validateCompanyMoaDocumentsPayload,
    normalizeCompanyMoaRow,
} from "../../utils/companyMoaValidation.js";
import {
    validateCompanyMemoDocumentsPayload,
    normalizeCompanyMemoRow,
} from "../../utils/companyMemoValidation.js";
import {
    validateCompanyLiveDocumentsPayload,
    normalizeCompanyLiveDocumentRow,
} from "../../utils/companyLiveDocumentValidation.js";
import {
    archiveAdminOwnerDocCardDeletion,
    stripOwnerDocFromPendingReactivation,
    ownerDocSnapshot,
} from "../../utils/companyOwnerDocDeletion.js";
import {
    isDocumentRemovalAttempt,
    isExplicitDestructiveCompanyPatch,
    userMayDeleteCompanyProfileContent,
    userMayCompactDeleteCompanyContent,
    isCompanyProfileActivated,
} from "../../utils/companyProfileDeleteAccess.js";

const ALLOWED_OWNER_DOC_KEYS = new Set([
    "passport",
    "visa",
    "visitVisa",
    "employmentVisa",
    "spouseVisa",
    "emiratesId",
    "medical",
    "drivingLicense",
    "labourCard",
    "attachment",
]);

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

const parseValidSubdocObjectIds = (arr) => {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const item of arr) {
        const s = String(item ?? "").trim();
        if (mongoose.Types.ObjectId.isValid(s)) {
            out.push(new mongoose.Types.ObjectId(s));
        }
    }
    return out;
};

const COMPANY_UPDATE_READ_EXCLUSIONS = {
    oldDocuments: 0,
    oldOwners: 0,
    "documents.document.data": 0,
    "insurance.document.data": 0,
    "ejari.document.data": 0,
    "pendingReactivationChanges.previousData": 0,
    "pendingReactivationChanges.proposedData": 0,
};

const normalizeDocumentRowsForUpdate = (documents = []) => {
    if (!Array.isArray(documents)) return documents;
    return documents.map((row) => {
        if (!row || typeof row !== "object") return row;
        const ctx = String(row.context || "").toLowerCase();
        const typeLower = String(row.type || "").toLowerCase();
        if (ctx === "certificate" || typeLower.includes("certificate")) {
            return normalizeCompanyCertificateRow(row);
        }
        if (ctx === "memo") return normalizeCompanyMemoRow(row);
        if (ctx === "moa" || typeLower.includes("moa")) return normalizeCompanyMoaRow(row);
        if (ctx === "document_with_expiry" || ctx === "document_without_expiry") {
            return normalizeCompanyLiveDocumentRow(row);
        }
        return row;
    });
};

const dualWriteBundleKeysToCoreSet = (coreSet, partitionUpdate = {}) => {
    for (const key of DOCUMENT_BUNDLE_KEYS) {
        if (Object.prototype.hasOwnProperty.call(partitionUpdate, key)) {
            coreSet[key] = partitionUpdate[key];
        }
    }
};

const TRADE_LICENSE_UPDATE_KEYS = [
    "tradeLicenseNumber",
    "tradeLicenseIssueDate",
    "tradeLicenseExpiry",
    "tradeLicenseAttachment",
    "tradeLicenseOwnerName",
];

/** Trade License modal only edits license fields + owner name/share — not owner email/phone. */
const isTradeLicenseOwnersBundleUpdate = (updateData = {}) =>
    Object.prototype.hasOwnProperty.call(updateData, "owners") &&
    TRADE_LICENSE_UPDATE_KEYS.some((k) => Object.prototype.hasOwnProperty.call(updateData, k));

const signCompanyProfileForResponse = async (companyObj = {}) => {
    const out = { ...companyObj };
    if (out.logo) out.logo = await getSignedFileUrl(out.logo);
    if (typeof out.tradeLicenseAttachment === "string" && out.tradeLicenseAttachment) {
        out.tradeLicenseAttachment = await getSignedFileUrl(out.tradeLicenseAttachment);
    }
    if (typeof out.establishmentCardAttachment === "string" && out.establishmentCardAttachment) {
        out.establishmentCardAttachment = await getSignedFileUrl(out.establishmentCardAttachment);
    }
    if (Array.isArray(out.documents)) out.documents = await signCompanyDocumentArray(out.documents);
    if (Array.isArray(out.oldDocuments)) out.oldDocuments = await signCompanyDocumentArray(out.oldDocuments);
    if (Array.isArray(out.insurance)) out.insurance = await signCompanyDocumentArray(out.insurance);
    if (Array.isArray(out.ejari)) out.ejari = await signCompanyDocumentArray(out.ejari);
    if (Array.isArray(out.owners)) {
        out.owners = await Promise.all(
            out.owners.map(async (owner) => {
                if (!owner || typeof owner !== "object") return owner;
                const o = { ...owner };
                if (typeof o.attachment === "string" && o.attachment) {
                    o.attachment = await getSignedFileUrl(o.attachment);
                }
                for (const key of [
                    "passport",
                    "visa",
                    "visitVisa",
                    "employmentVisa",
                    "spouseVisa",
                    "emiratesId",
                    "medical",
                    "drivingLicense",
                    "labourCard",
                ]) {
                    if (typeof o[key]?.attachment === "string" && o[key].attachment) {
                        o[key] = { ...o[key], attachment: await getSignedFileUrl(o[key].attachment) };
                    }
                }
                return o;
            }),
        );
    }
    return out;
};

export const updateCompany = async (req, res) => {
    try {
        const { id } = req.params;
        const companyFilter = {
            $or: [{ _id: id.match(/^[0-9a-fA-F]{24}$/) ? id : null }, { companyId: id }],
        };

        let company = await Company.findOne(companyFilter)
            .select(COMPANY_UPDATE_READ_EXCLUSIONS)
            .maxTimeMS(15000);
        if (!company) {
            return res.status(404).json({ message: "Company not found" });
        }

        const updateData = { ...req.body };
        normalizeCompanyUpdateAttachments(updateData);
        const skipArchiveOnRequest =
            updateData.skipArchive === true ||
            String(req.query?.skipArchive || "").toLowerCase() === "true";
        delete updateData.skipArchive;

        const requesterIsAdmin = await isReqUserAdmin(req.user);
        const requesterIsDesignatedHr = await isRequestUserDesignatedFlowchartHr(req);
        const requesterBypassesHrQueue = requesterIsAdmin || requesterIsDesignatedHr;

        let clearLiveOwnerDocCard = null;
        let clearOldOwnerDocCard = null;
        if (Object.prototype.hasOwnProperty.call(updateData, "clearLiveOwnerDocCard")) {
            clearLiveOwnerDocCard = updateData.clearLiveOwnerDocCard;
            delete updateData.clearLiveOwnerDocCard;
        }
        if (Object.prototype.hasOwnProperty.call(updateData, "clearOldOwnerDocCard")) {
            clearOldOwnerDocCard = updateData.clearOldOwnerDocCard;
            delete updateData.clearOldOwnerDocCard;
        }

        if (clearLiveOwnerDocCard || clearOldOwnerDocCard) {
            if (!requesterIsAdmin && !requesterIsDesignatedHr) {
                return res.status(403).json({
                    message: "Only administrator can delete owner document cards.",
                });
            }

            const clearSpec = clearLiveOwnerDocCard || clearOldOwnerDocCard;
            const ownerTarget = clearLiveOwnerDocCard ? "owners" : "oldOwners";
            const ownerId = String(clearSpec?.ownerId ?? "").trim();
            const docKey = String(clearSpec?.docKey ?? "").trim();

            if (!/^[a-fA-F0-9]{24}$/.test(ownerId)) {
                return res.status(400).json({ message: "Invalid owner id for document delete." });
            }
            if (!ALLOWED_OWNER_DOC_KEYS.has(docKey)) {
                return res.status(400).json({ message: "Invalid owner document type." });
            }

            const beforeCompany =
                (await loadCompanyFullProfile(company)) ||
                (typeof company.toObject === "function"
                    ? company.toObject({ strict: false, virtuals: false })
                    : { ...company });

            const ownerRow = findOwnerRow(beforeCompany[ownerTarget], ownerId);
            if (!ownerRow) {
                return res.status(404).json({ message: "Owner record not found." });
            }
            if (!ownerDocSnapshot(ownerRow, docKey)) {
                return res.status(404).json({ message: "Owner document card not found." });
            }

            if (!skipArchiveOnRequest) {
                await archiveAdminOwnerDocCardDeletion(req, beforeCompany, ownerRow, docKey, ownerTarget);
            }

            const strippedPending = stripOwnerDocFromPendingReactivation(
                beforeCompany.pendingReactivationChanges || [],
                ownerId,
                docKey,
            );

            const clearResult = await clearOwnerDocInPartition(company._id, ownerTarget, ownerId, docKey);
            if (!clearResult.modified) {
                return res.status(404).json({ message: "Owner document card not found." });
            }

            if (strippedPending !== beforeCompany.pendingReactivationChanges) {
                await upsertCompanyPartitions(company._id, {
                    pendingReactivationChanges: strippedPending,
                });
            }

            const refreshed = await Company.findById(company._id)
                .select(COMPANY_UPDATE_READ_EXCLUSIONS)
                .maxTimeMS(8000);
            const fullProfile = await loadCompanyFullProfile(refreshed);
            const signed = await signCompanyProfileForResponse(fullProfile || {});

            const ownerIndex = (beforeCompany.owners || []).findIndex(
                (o) => o && String(o._id || o.id) === ownerId,
            );
            if (ownerIndex >= 0) {
                await closeCreatorNotRenewFollowUpTasks(company._id, {
                    kind: "ownerDoc",
                    ownerIndex,
                    docKey,
                });
            }

            return res.status(200).json({
                message: "Owner document card removed successfully.",
                company: signed,
                activationProgress: calculateCompanyActivationProgress(fullProfile || {}),
            });
        }

        const isCompanyDocumentNotRenewArchive =
            updateData.companyDocumentNotRenew === true &&
            Array.isArray(updateData.documents) &&
            updateData.documents.length > 0 &&
            String(updateData.documents[0]?.description || "")
                .toLowerCase()
                .includes("not renew");
        delete updateData.companyDocumentNotRenew;

        const pullDocumentsByIds = parseValidSubdocObjectIds(updateData.pullDocumentsByIds);
        const pullOldDocumentsByIds = parseValidSubdocObjectIds(updateData.pullOldDocumentsByIds);
        const pullOwnersByIds = parseValidSubdocObjectIds(updateData.pullOwnersByIds);

        let retireLiveDocumentOid = null;
        if (Object.prototype.hasOwnProperty.call(updateData, "retireLiveDocumentById")) {
            const rs =
                updateData.retireLiveDocumentById != null
                    ? String(updateData.retireLiveDocumentById).trim()
                    : "";
            if (rs && mongoose.Types.ObjectId.isValid(rs)) {
                retireLiveDocumentOid = new mongoose.Types.ObjectId(rs);
            }
            delete updateData.retireLiveDocumentById;
        }

        const compactCompanyDocMutation =
            pullDocumentsByIds.length > 0 ||
            pullOldDocumentsByIds.length > 0 ||
            pullOwnersByIds.length > 0 ||
            Boolean(retireLiveDocumentOid);

        delete updateData.pullDocumentsByIds;
        delete updateData.pullOldDocumentsByIds;
        delete updateData.pullOwnersByIds;

        if (compactCompanyDocMutation) {
            const mayCompactDelete =
                requesterIsAdmin ||
                requesterBypassesHrQueue ||
                (await userMayCompactDeleteCompanyContent(req.user, company, {
                    pullDocumentsByIds,
                    pullOldDocumentsByIds,
                    pullOwnersByIds,
                }));
            if (!mayCompactDelete) {
                const activated = isCompanyProfileActivated(company);
                return res.status(403).json({
                    message: activated
                        ? "Only administrator can remove company documents or owners on an activated profile."
                        : "You do not have permission to delete this company profile content.",
                });
            }
            const filter = { _id: company._id };
            const pullOps = {};
            if (pullDocumentsByIds.length) pullOps.documents = { _id: { $in: pullDocumentsByIds } };
            if (pullOldDocumentsByIds.length) pullOps.oldDocuments = { _id: { $in: pullOldDocumentsByIds } };
            if (pullOwnersByIds.length) pullOps.owners = { _id: { $in: pullOwnersByIds } };
            if (Object.keys(pullOps).length) {
                await Company.updateOne(filter, { $pull: pullOps });
            }
            if (retireLiveDocumentOid) {
                await Company.updateOne(filter, {
                    $pull: { documents: { _id: retireLiveDocumentOid } },
                });
            }
            const refreshed = await Company.findById(company._id)
                .select(COMPANY_UPDATE_READ_EXCLUSIONS)
                .maxTimeMS(8000);
            const fullProfile = await loadCompanyFullProfile(refreshed);
            const signed = await signCompanyProfileForResponse(fullProfile || {});
            if (pullDocumentsByIds.length || retireLiveDocumentOid) {
                await closeCreatorNotRenewFollowUpTasks(company._id, {
                    kind: "document",
                    closeAllOfKind: true,
                });
            }
            if (pullOwnersByIds.length) {
                await closeCreatorNotRenewFollowUpTasks(company._id, {
                    kind: "ownerDoc",
                    closeAllOfKind: true,
                });
            }
            return res.status(200).json({
                message: "Company updated successfully",
                company: signed,
                activationProgress: calculateCompanyActivationProgress(fullProfile || {}),
            });
        }

        const beforeCompany =
            (await loadCompanyFullProfile(company)) ||
            (typeof company.toObject === "function"
                ? company.toObject({ strict: false, virtuals: false })
                : { ...company });

        const hasGroupDeletePerm = await userMayDeleteCompanyProfileContent(
            req.user,
            beforeCompany,
            updateData,
        );
        const profileActivated = isCompanyProfileActivated(beforeCompany);
        const looksLikeRemoval = isDocumentRemovalAttempt(beforeCompany, updateData);
        const unmistakableDelete = isExplicitDestructiveCompanyPatch(beforeCompany, updateData);
        const blockAsDelete =
            looksLikeRemoval &&
            !isCompanyDocumentNotRenewArchive &&
            !shouldTriggerCompanyReactivation(beforeCompany, updateData) &&
            (!profileActivated || unmistakableDelete);

        if (!requesterIsAdmin && !requesterBypassesHrQueue && !hasGroupDeletePerm && blockAsDelete) {
            return res.status(403).json({
                message: profileActivated
                    ? "Only administrator can delete company profile documents or card attachments on an activated profile."
                    : "You do not have permission to delete this company profile content.",
            });
        }

        if (Object.prototype.hasOwnProperty.call(updateData, "tradeLicenseNumber")) {
            try {
                updateData.tradeLicenseNumber = normalizeTradeLicenseNumber(updateData.tradeLicenseNumber);
            } catch (e) {
                return res.status(400).json({ message: e.message || "Invalid License Number" });
            }
            const tlValidation = validateTradeLicensePayload(updateData, { requireAttachment: true });
            if (!tlValidation.ok) {
                return res.status(400).json({ message: tlValidation.message });
            }
            const duplicateLicense = await CompanyCompliance.findOne({
                company: { $ne: company._id },
                tradeLicenseNumber: updateData.tradeLicenseNumber,
            })
                .lean()
                .maxTimeMS(8000);
            if (duplicateLicense) {
                return res.status(400).json({ message: "License Number already exists" });
            }
        } else if (
            updateData.tradeLicenseExpiry !== undefined &&
            updateData.tradeLicenseExpiry !== null &&
            updateData.tradeLicenseExpiry !== ""
        ) {
            const parsed = new Date(updateData.tradeLicenseExpiry);
            if (Number.isNaN(parsed.getTime())) {
                return res.status(400).json({ message: "Invalid Trade License expiry date" });
            }
        } else if (updateData.tradeLicenseExpiry === "") {
            updateData.tradeLicenseExpiry = null;
        }

        if (Object.prototype.hasOwnProperty.call(updateData, "establishmentCardNumber")) {
            try {
                updateData.establishmentCardNumber = normalizeEstablishmentCardNumber(
                    updateData.establishmentCardNumber,
                );
            } catch (e) {
                return res.status(400).json({ message: e.message || "Invalid Card Number" });
            }
            const ecValidation = validateEstablishmentCardPayload(updateData, { requireAttachment: true });
            if (!ecValidation.ok) {
                return res.status(400).json({ message: ecValidation.message });
            }
            const duplicateCard = await CompanyCompliance.findOne({
                company: { $ne: company._id },
                establishmentCardNumber: updateData.establishmentCardNumber,
            })
                .lean()
                .maxTimeMS(8000);
            if (duplicateCard) {
                return res.status(400).json({ message: "Card Number already exists" });
            }
        } else if (
            updateData.establishmentCardExpiry !== undefined &&
            updateData.establishmentCardExpiry !== null &&
            updateData.establishmentCardExpiry !== ""
        ) {
            const expiryErr = validateEstablishmentCardExpiryDate(updateData.establishmentCardExpiry);
            if (expiryErr) {
                return res.status(400).json({ message: expiryErr });
            }
        } else if (updateData.establishmentCardExpiry === "") {
            updateData.establishmentCardExpiry = null;
        }

        if (Object.prototype.hasOwnProperty.call(updateData, "ejari")) {
            try {
                if (Array.isArray(updateData.ejari)) {
                    updateData.ejari = updateData.ejari.map((row) => normalizeEjariRow(row));
                }
                const ejariCheck = validateEjariArrayPayload(updateData.ejari);
                if (!ejariCheck.ok) {
                    return res.status(400).json({ message: ejariCheck.message });
                }
            } catch (e) {
                return res.status(400).json({ message: e.message || "Invalid Ejari data" });
            }
        }

        if (Object.prototype.hasOwnProperty.call(updateData, "documents")) {
            if (Array.isArray(updateData.documents)) {
                updateData.documents = normalizeDocumentRowsForUpdate(updateData.documents);
            }
            const certificateCheck = validateCompanyCertificateDocumentsPayload(updateData.documents);
            if (!certificateCheck.ok) {
                return res.status(400).json({ message: certificateCheck.message });
            }
            const moaCheck = validateCompanyMoaDocumentsPayload(updateData.documents);
            if (!moaCheck.ok) {
                return res.status(400).json({ message: moaCheck.message });
            }
            const memoCheck = validateCompanyMemoDocumentsPayload(updateData.documents);
            if (!memoCheck.ok) {
                return res.status(400).json({ message: memoCheck.message });
            }
            const liveDocCheck = validateCompanyLiveDocumentsPayload(updateData.documents);
            if (!liveDocCheck.ok) {
                return res.status(400).json({ message: liveDocCheck.message });
            }
        }

        if (Object.prototype.hasOwnProperty.call(updateData, "owners")) {
            try {
                const globalUsed = await collectGlobalOwnerProfileIds();
                updateData.owners = normalizeTradeLicenseOwners(updateData.owners, globalUsed);
                updateData.owners = updateData.owners.map((row) => {
                    const normalized = normalizeOwnerDetailsRow(row);
                    if (row?.passport && typeof row.passport === "object") {
                        normalized.passport = normalizeOwnerPassportRow(row.passport);
                    }
                    if (row?.emiratesId && typeof row.emiratesId === "object") {
                        normalized.emiratesId = normalizeOwnerEmiratesIdRow(row.emiratesId);
                    }
                    for (const visaKey of ["visitVisa", "employmentVisa", "spouseVisa"]) {
                        if (row?.[visaKey] && typeof row[visaKey] === "object") {
                            normalized[visaKey] = normalizeOwnerVisaRow(row[visaKey]);
                        }
                    }
                    if (row?.visa && typeof row.visa === "object") {
                        normalized.visa = normalizeOwnerVisaRow(row.visa);
                    }
                    if (row?.labourCard && typeof row.labourCard === "object") {
                        normalized.labourCard = normalizeOwnerLabourCardRow(row.labourCard);
                    }
                    if (row?.medical && typeof row.medical === "object") {
                        normalized.medical = normalizeOwnerMedicalInsuranceRow(row.medical);
                    }
                    if (row?.drivingLicense && typeof row.drivingLicense === "object") {
                        normalized.drivingLicense = normalizeOwnerDrivingLicenseRow(row.drivingLicense);
                    }
                    return normalized;
                });
                const ownersCheck = validateTradeLicenseOwnersPayload(updateData.owners);
                if (!ownersCheck.ok) {
                    return res.status(400).json({ message: ownersCheck.message });
                }
                const profileActive =
                    String(company?.status || "").toLowerCase() === "active" &&
                    String(company?.activationStatus || "").toLowerCase() === "active";
                const tradeLicenseOwnersOnly = isTradeLicenseOwnersBundleUpdate(updateData);
                if (!tradeLicenseOwnersOnly) {
                    const detailsCheck = validateOwnerDetailsOwnersPayload(updateData.owners, {
                        requireEmail: profileActive,
                        profileActive,
                    });
                    if (!detailsCheck.ok) {
                        return res.status(400).json({ message: detailsCheck.message });
                    }
                    const passportCheck = validateOwnersPassportPayload(updateData.owners);
                    if (!passportCheck.ok) {
                        return res.status(400).json({ message: passportCheck.message });
                    }
                    const emiratesIdCheck = validateOwnersEmiratesIdPayload(updateData.owners);
                    if (!emiratesIdCheck.ok) {
                        return res.status(400).json({ message: emiratesIdCheck.message });
                    }
                    const visaCheck = validateOwnersVisaPayload(updateData.owners);
                    if (!visaCheck.ok) {
                        return res.status(400).json({ message: visaCheck.message });
                    }
                    const labourCardCheck = validateOwnersLabourCardPayload(updateData.owners);
                    if (!labourCardCheck.ok) {
                        return res.status(400).json({ message: labourCardCheck.message });
                    }
                    const medicalCheck = validateOwnersMedicalInsurancePayload(updateData.owners);
                    if (!medicalCheck.ok) {
                        return res.status(400).json({ message: medicalCheck.message });
                    }
                    const drivingLicenseCheck = validateOwnersDrivingLicensePayload(updateData.owners);
                    if (!drivingLicenseCheck.ok) {
                        return res.status(400).json({ message: drivingLicenseCheck.message });
                    }
                }
            } catch (e) {
                return res.status(400).json({ message: e.message || "Invalid owner data" });
            }
        }

        if (pullOwnersByIds.length > 0) {
            const liveOwners = beforeCompany.owners || [];
            const remainingCount = liveOwners.filter(
                (o) => !pullOwnersByIds.some((oid) => String(o?._id || o?.id) === String(oid)),
            ).length;
            if (remainingCount < 1) {
                return res.status(400).json({
                    message: "At least one owner is required. You cannot remove the only owner.",
                });
            }
        }

        const addressFieldsTouched = ["address", "country", "state", "city", "postalCode"].some((k) =>
            Object.prototype.hasOwnProperty.call(updateData, k),
        );
        if (addressFieldsTouched) {
            try {
                if (Object.prototype.hasOwnProperty.call(updateData, "address")) {
                    updateData.address = sanitizeCompanyAddressField(updateData.address, "Company Address");
                }
                if (Object.prototype.hasOwnProperty.call(updateData, "country")) {
                    updateData.country = sanitizeCompanyAddressField(updateData.country, "Country");
                }
                if (Object.prototype.hasOwnProperty.call(updateData, "state")) {
                    updateData.state = sanitizeCompanyAddressField(updateData.state, "State / Emirates");
                }
                if (Object.prototype.hasOwnProperty.call(updateData, "city")) {
                    updateData.city = sanitizeCompanyAddressField(updateData.city, "City");
                }
                if (Object.prototype.hasOwnProperty.call(updateData, "postalCode")) {
                    updateData.postalCode = sanitizeCompanyAddressField(updateData.postalCode, "PO Box");
                }
            } catch (e) {
                return res.status(400).json({ message: e.message || "Invalid address field" });
            }
            const addressValidation = validateCompanyAddressPayload({
                address: Object.prototype.hasOwnProperty.call(updateData, "address")
                    ? updateData.address
                    : beforeCompany.address,
                country: Object.prototype.hasOwnProperty.call(updateData, "country")
                    ? updateData.country
                    : beforeCompany.country,
                state: Object.prototype.hasOwnProperty.call(updateData, "state")
                    ? updateData.state
                    : beforeCompany.state,
                city: Object.prototype.hasOwnProperty.call(updateData, "city")
                    ? updateData.city
                    : beforeCompany.city,
                postalCode: Object.prototype.hasOwnProperty.call(updateData, "postalCode")
                    ? updateData.postalCode
                    : beforeCompany.postalCode,
            });
            if (!addressValidation.ok) {
                return res.status(400).json({ message: addressValidation.message });
            }
        }

        const hrQueueRequired =
            !requesterBypassesHrQueue && shouldTriggerCompanyReactivation(beforeCompany, updateData);
        const skipReactivationQueueForThisRequest = skipArchiveOnRequest && !hrQueueRequired;

        let partitionUpdatePayload = {};
        const queueForApproval = !skipReactivationQueueForThisRequest && hrQueueRequired;

        const findOpts = {
            new: true,
            runValidators: true,
            projection: COMPANY_UPDATE_READ_EXCLUSIONS,
        };

        let updatedCompany = null;
        let responseMessage = "Company updated successfully";

        if (queueForApproval) {
            const changedCards = collectCompanyReactivationChangeLabels(updateData, beforeCompany);
            const cardLabel = changedCards.length ? changedCards.join(", ") : "Company Profile";
            // Active companies stay Active; changes wait in pendingReactivationChanges until HR approves via Submit.
            const pendingEntry = {
                card: cardLabel,
                reason: cardLabel,
                section: "companyProfile",
                changeType: "update",
                targetIndex: null,
                previousData: toSerializable(pickCompanyPendingPreviousSnapshot(beforeCompany, updateData)),
                proposedData: toSerializable(updateData),
                changedAt: new Date(),
            };
            const holdUnapproved = new Set(
                (beforeCompany.activationHold?.unapprovedEntryIds || []).map((x) => String(x)),
            );
            let nextPending = [...(beforeCompany.pendingReactivationChanges || [])];
            let mergedIntoHeldRow = false;
            if (holdUnapproved.size > 0 && changedCards.length > 0) {
                const changedNorm = new Set(changedCards.map((c) => String(c || "").toLowerCase().trim()));
                nextPending = nextPending.map((entry, idx) => {
                    const entryId = companyPendingEntryId(entry, idx);
                    if (!holdUnapproved.has(entryId)) return entry;
                    const needed = labelsRequiredForActivationHoldEntry(entry);
                    const overlaps =
                        needed.length === 0 ||
                        needed.some((label) => changedNorm.has(String(label || "").toLowerCase().trim()));
                    if (!overlaps) return entry;
                    mergedIntoHeldRow = true;
                    return {
                        ...entry,
                        card: cardLabel,
                        reason: cardLabel,
                        section: entry.section || "companyProfile",
                        changeType: entry.changeType || "update",
                        previousData: pendingEntry.previousData,
                        proposedData: pendingEntry.proposedData,
                        changedAt: pendingEntry.changedAt,
                    };
                });
            }
            if (!mergedIntoHeldRow) {
                nextPending = [...nextPending, pendingEntry];
            }
            partitionUpdatePayload = { pendingReactivationChanges: nextPending };
            updatedCompany = await company.save();
            responseMessage = isCompanyFullyActivated(beforeCompany)
                ? "Change queued for HR review. Submit for HR approval when you are finished editing."
                : "Company change queued for HR activation approval.";
        } else {
            if (!skipReactivationQueueForThisRequest) {
                await archiveSupersededCompanyDocuments(beforeCompany, updateData);
            }
            if (!skipReactivationQueueForThisRequest) {
                archiveSupersededCompanyOwners(beforeCompany, updateData);
            }

            const updateOps = {};
            if (Object.keys(updateData).length > 0) {
                normalizeCompanyUpdateAttachments(updateData);
                const { coreUpdate, partitionUpdate } = splitCompanyUpdatePayload(updateData);
                partitionUpdatePayload = partitionUpdate;
                if (Object.keys(coreUpdate).length > 0) {
                    updateOps.$set = { ...(updateOps.$set || {}), ...coreUpdate };
                }
                if (Object.keys(partitionUpdate).length > 0) {
                    const bundleDualWrite = {};
                    dualWriteBundleKeysToCoreSet(bundleDualWrite, partitionUpdate);
                    if (Object.keys(bundleDualWrite).length > 0) {
                        updateOps.$set = { ...(updateOps.$set || {}), ...bundleDualWrite };
                    }
                }
            }

            const keysToStripFromPending = [];
            if (Object.prototype.hasOwnProperty.call(updateData, "establishmentCardNumber")) {
                keysToStripFromPending.push(
                    "establishmentCardNumber",
                    "establishmentCardIssueDate",
                    "establishmentCardExpiry",
                    "establishmentCardAttachment",
                );
            }
            if (keysToStripFromPending.length && Array.isArray(beforeCompany.pendingReactivationChanges)) {
                const stripped = stripProposedDataKeysFromPendingReactivationEntries(
                    beforeCompany.pendingReactivationChanges,
                    keysToStripFromPending,
                );
                if (stripped !== beforeCompany.pendingReactivationChanges) {
                    partitionUpdatePayload = {
                        ...partitionUpdatePayload,
                        pendingReactivationChanges: stripped,
                    };
                }
            }

            if (Object.keys(updateOps).length === 0) {
                updatedCompany = company;
            } else {
                updatedCompany = await Company.findByIdAndUpdate(company._id, updateOps, findOpts);
            }
        }

        try {
            if (Object.keys(partitionUpdatePayload).length > 0) {
                await upsertCompanyPartitions(updatedCompany._id, partitionUpdatePayload);
            } else if (!queueForApproval) {
                const fullRow = await Company.findById(updatedCompany._id).lean().maxTimeMS(8000);
                if (fullRow) {
                    await upsertCompanyPartitions(updatedCompany._id, fullRow);
                }
            }
        } catch (partitionErr) {
            console.warn("[updateCompany] upsertCompanyPartitions:", partitionErr?.message || partitionErr);
        }

        try {
            await markCompanyActivationHoldResolvedForUpdate(updatedCompany._id, updateData);
        } catch (holdErr) {
            console.warn(
                "[updateCompany] markCompanyActivationHoldResolvedForUpdate:",
                holdErr?.message || holdErr,
            );
        }

        if (!queueForApproval) {
            try {
                await reconcileCompanyDocumentExpiryDashboard(updatedCompany._id);
            } catch (expiryErr) {
                console.warn(
                    "[updateCompany] reconcileCompanyDocumentExpiryDashboard:",
                    expiryErr?.message || expiryErr,
                );
            }
        }

        if (Object.prototype.hasOwnProperty.call(updateData, "responsibilities")) {
            const responsibilities = updateData.responsibilities;
            const prev = beforeCompany.responsibilities || [];
            for (const resp of responsibilities || []) {
                if (resp?.status === "Pending" && resp?.empObjectId) {
                    const existed = (prev || []).find(
                        (r) =>
                            String(r?.empObjectId || "") === String(resp.empObjectId) &&
                            String(r?.category || "") === String(resp.category || ""),
                    );
                    if (!existed || existed.status !== "Pending") {
                        try {
                            const emailData = await buildResponsibilityEmailData({
                                company: beforeCompany,
                                responsibility: resp,
                            });
                            if (emailData) {
                                await sendResponsibilityApprovalEmail(emailData);
                            }
                            await syncDashboardAction({
                                requestId: updatedCompany._id,
                                requestType: "Responsibility Approval",
                                assignedTo: String(resp.empObjectId),
                                status: "Pending",
                                subjectEmployee: {
                                    employeeId: beforeCompany.companyId,
                                    firstName: beforeCompany.name,
                                    lastName: "",
                                },
                                extra1: `Responsibility: ${resp.category || "Category"}`,
                                extra2: beforeCompany.companyId || "",
                            });
                        } catch (emailErr) {
                            console.warn(
                                "[updateCompany] responsibility notification:",
                                emailErr?.message || emailErr,
                            );
                        }
                    }
                }
            }
        }

        const mergedForResponse =
            (await loadCompanyFullProfile(updatedCompany)) ||
            (typeof updatedCompany.toObject === "function"
                ? updatedCompany.toObject({ strict: false, virtuals: false })
                : { ...updatedCompany });

        const signedCompany = await signCompanyProfileForResponse(mergedForResponse);

        try {
            await closeCreatorNotRenewFollowUpsFromCompanyUpdate(updatedCompany._id, updateData);
        } catch (followUpErr) {
            console.warn(
                "[updateCompany] closeCreatorNotRenewFollowUps:",
                followUpErr?.message || followUpErr,
            );
        }

        return res.status(200).json({
            message: responseMessage,
            company: signedCompany,
            activationProgress: calculateCompanyActivationProgress(mergedForResponse),
            queuedForHrApproval: queueForApproval,
        });
    } catch (error) {
        console.error("Error in updateCompany:", error);
        return res.status(500).json({ message: error.message || "Failed to update company" });
    }
};
