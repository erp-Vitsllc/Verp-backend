import mongoose from "mongoose";
import Company from "../../models/Company.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import User from "../../models/User.js";
import DashboardAction from "../../models/DashboardAction.js";
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
    stripProposedDataKeysFromPendingReactivationEntries,
} from "../../utils/companyActivation.js";
import { markCompanyActivationHoldResolvedForUpdate } from "../../utils/markCompanyActivationHoldResolved.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";
import { awaitAdminDeletionArchive } from "../../utils/adminDeletionArchiveRun.js";
import {
    archiveAdminOwnerDocCardDeletion,
    stripOwnerDocFromPendingReactivation,
    ownerDocUnsetPath,
} from "../../utils/companyOwnerDocDeletion.js";

async function awaitAdminCompanyPullArchives(
    req,
    company,
    { pullDocumentsByIds = [], pullOldDocumentsByIds = [], pullOwnersByIds = [] } = {}
) {
    const companyId = company.companyId;
    const companyName = company.name || companyId;
    const tasks = [];

    for (const oid of pullDocumentsByIds) {
        const document = (company.documents || []).find((d) => String(d._id) === String(oid));
        if (!document) continue;
        tasks.push(
            awaitAdminDeletionArchive(req, {
                moduleName: 'Company Document',
                recordId: companyId,
                details: `${document.type || 'Document'} removed from ${companyName}`,
                deletedPayload: { companyId, companyName, document },
            })
        );
    }

    for (const oid of pullOldDocumentsByIds) {
        const document = (company.oldDocuments || []).find((d) => String(d._id) === String(oid));
        if (!document) continue;
        tasks.push(
            awaitAdminDeletionArchive(req, {
                moduleName: 'Company Old Document',
                recordId: companyId,
                details: `${document.type || 'Archived document'} removed from ${companyName}`,
                deletedPayload: { companyId, companyName, document },
            })
        );
    }

    for (const oid of pullOwnersByIds) {
        const owner = (company.owners || []).find((o) => String(o._id) === String(oid));
        if (!owner) continue;
        tasks.push(
            awaitAdminDeletionArchive(req, {
                moduleName: 'Company Owner',
                recordId: companyId,
                details: `Owner removed from ${companyName}`,
                deletedPayload: { companyId, companyName, owner, ownerTarget: 'owners' },
            })
        );
    }

    await Promise.all(tasks);
}

const shouldQueueCompanyChange = (company = {}) => {
    const status = String(company?.status || "").toLowerCase();
    if (status === "active") return true;
    const workflow = Array.isArray(company?.activationWorkflow) ? company.activationWorkflow : [];
    const hasEverBeenActive = workflow.some((w) => String(w?.status || "").toLowerCase() === "active");
    return hasEverBeenActive;
};

const toSerializable = (value) => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (_error) {
        return value;
    }
};

/** For $pull on company document sub-arrays without sending multi‑MB `documents` / `oldDocuments` bodies. */
const parseValidSubdocObjectIds = (arr) => {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const id of arr) {
        const s = id != null ? String(id).trim() : "";
        if (s && mongoose.Types.ObjectId.isValid(s)) out.push(new mongoose.Types.ObjectId(s));
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

export const updateCompany = async (req, res) => {
    try {
        const { id } = req.params;

        // Find by _id or companyId
        let company = await Company.findOne({
            $or: [{ _id: id.match(/^[0-9a-fA-F]{24}$/) ? id : null }, { companyId: id }]
        })
            .select(COMPANY_UPDATE_READ_EXCLUSIONS)
            .maxTimeMS(5000);

        if (!company) {
            return res.status(404).json({ message: "Company not found" });
        }

        // Update fields provided in req.body
        const updateData = req.body;
        const beforeCompany = company.toObject();
        const requesterIsAdmin = await isReqUserAdmin(req.user);

        const isCompanyDocumentNotRenewArchive =
            updateData.companyDocumentNotRenew === true &&
            Array.isArray(updateData.documents) &&
            updateData.documents.length > 0 &&
            typeof updateData.documents[0]?.description === "string" &&
            updateData.documents[0].description.toLowerCase().includes("not renewed");
        if (Object.prototype.hasOwnProperty.call(updateData, "companyDocumentNotRenew")) {
            delete updateData.companyDocumentNotRenew;
        }

        /** Old-tab hard deletes / admin cleanup send this so the PATCH applies immediately instead of queuing reactivation. */
        let skipReactivationQueueForThisRequest = false;
        if (Object.prototype.hasOwnProperty.call(updateData, "skipArchive") && updateData.skipArchive === true) {
            skipReactivationQueueForThisRequest = true;
            delete updateData.skipArchive;
        }

        const pullDocumentsByIds = parseValidSubdocObjectIds(updateData.pullDocumentsByIds);
        const pullOldDocumentsByIds = parseValidSubdocObjectIds(updateData.pullOldDocumentsByIds);
        const pullOwnersByIds = parseValidSubdocObjectIds(updateData.pullOwnersByIds);
        delete updateData.pullDocumentsByIds;
        delete updateData.pullOldDocumentsByIds;
        delete updateData.pullOwnersByIds;

        let retireLiveDocumentOid = null;
        if (Object.prototype.hasOwnProperty.call(updateData, "retireLiveDocumentById")) {
            const rs = updateData.retireLiveDocumentById != null ? String(updateData.retireLiveDocumentById).trim() : "";
            if (rs && mongoose.Types.ObjectId.isValid(rs)) retireLiveDocumentOid = new mongoose.Types.ObjectId(rs);
            delete updateData.retireLiveDocumentById;
        }

        let clearOldOwnerDocCard = null;
        if (updateData.clearOldOwnerDocCard && typeof updateData.clearOldOwnerDocCard === "object") {
            const raw = updateData.clearOldOwnerDocCard;
            const oidStr = raw.ownerId != null ? String(raw.ownerId).trim() : "";
            const docKey = raw.docKey != null ? String(raw.docKey).trim() : "";
            const allowedOldOwnerDocKeys = new Set([
                "attachment",
                "passport",
                "visa",
                "emiratesId",
                "medical",
                "drivingLicense",
                "labourCard",
            ]);
            if (oidStr && mongoose.Types.ObjectId.isValid(oidStr) && allowedOldOwnerDocKeys.has(docKey)) {
                const ownerRow = (beforeCompany.oldOwners || []).find((o) => String(o?._id || o?.id) === oidStr);
                if (ownerRow) {
                    clearOldOwnerDocCard = { ownerId: new mongoose.Types.ObjectId(oidStr), docKey };
                }
            }
            delete updateData.clearOldOwnerDocCard;
        }

        let clearLiveOwnerDocCard = null;
        if (updateData.clearLiveOwnerDocCard && typeof updateData.clearLiveOwnerDocCard === "object") {
            const raw = updateData.clearLiveOwnerDocCard;
            const oidStr = raw.ownerId != null ? String(raw.ownerId).trim() : "";
            const docKey = raw.docKey != null ? String(raw.docKey).trim() : "";
            const allowedLiveOwnerDocKeys = new Set([
                "attachment",
                "passport",
                "visa",
                "emiratesId",
                "medical",
                "drivingLicense",
                "labourCard",
            ]);
            if (oidStr && mongoose.Types.ObjectId.isValid(oidStr) && allowedLiveOwnerDocKeys.has(docKey)) {
                const ownerRow = (beforeCompany.owners || []).find((o) => String(o?._id || o?.id) === oidStr);
                if (ownerRow) {
                    clearLiveOwnerDocCard = { ownerId: new mongoose.Types.ObjectId(oidStr), docKey };
                }
            }
            delete updateData.clearLiveOwnerDocCard;
        }

        const compactCompanyDocMutation =
            pullDocumentsByIds.length > 0 ||
            pullOldDocumentsByIds.length > 0 ||
            pullOwnersByIds.length > 0 ||
            Boolean(retireLiveDocumentOid) ||
            Boolean(clearOldOwnerDocCard) ||
            Boolean(clearLiveOwnerDocCard);
        if (compactCompanyDocMutation && !requesterIsAdmin) {
            return res.status(403).json({
                message: "Only administrator can remove or archive company documents this way.",
            });
        }

        /** Admin hard-clear + skipArchive: apply immediately and strip matching queued proposals so UI/progress do not keep showing removed cards. */
        const adminEstablishmentHardClear =
            requesterIsAdmin &&
            skipReactivationQueueForThisRequest &&
            Object.prototype.hasOwnProperty.call(updateData, "establishmentCardNumber") &&
            updateData.establishmentCardNumber === null &&
            Object.prototype.hasOwnProperty.call(updateData, "establishmentCardExpiry") &&
            updateData.establishmentCardExpiry === null &&
            Object.prototype.hasOwnProperty.call(updateData, "establishmentCardAttachment") &&
            updateData.establishmentCardAttachment === null;

        const adminTradeLicenseHardClear =
            requesterIsAdmin &&
            skipReactivationQueueForThisRequest &&
            Object.prototype.hasOwnProperty.call(updateData, "tradeLicenseNumber") &&
            updateData.tradeLicenseNumber === null &&
            Object.prototype.hasOwnProperty.call(updateData, "tradeLicenseIssueDate") &&
            updateData.tradeLicenseIssueDate === null &&
            Object.prototype.hasOwnProperty.call(updateData, "tradeLicenseExpiry") &&
            updateData.tradeLicenseExpiry === null &&
            Object.prototype.hasOwnProperty.call(updateData, "tradeLicenseAttachment") &&
            updateData.tradeLicenseAttachment === null;

        const pendingStripKeys = [];
        if (adminEstablishmentHardClear) {
            pendingStripKeys.push(
                "establishmentCardNumber",
                "establishmentCardIssueDate",
                "establishmentCardExpiry",
                "establishmentCardAttachment",
            );
        }
        if (adminTradeLicenseHardClear) {
            pendingStripKeys.push(
                "tradeLicenseNumber",
                "tradeLicenseIssueDate",
                "tradeLicenseExpiry",
                "tradeLicenseAttachment",
                "tradeLicenseOwnerName",
            );
        }
        if (pendingStripKeys.length > 0) {
            updateData.pendingReactivationChanges = stripProposedDataKeysFromPendingReactivationEntries(
                beforeCompany.pendingReactivationChanges || [],
                pendingStripKeys,
            );
        }

        const collectAttachmentUrls = (items = [], path = "document.url") => {
            const [root, leaf, nested] = path.split(".");
            const urls = [];
            (items || []).forEach((item) => {
                let value;
                if (nested) value = item?.[root]?.[leaf]?.[nested];
                else if (leaf) value = item?.[root]?.[leaf];
                else value = item?.[root];
                if (typeof value === "string" && value.trim()) urls.push(value.trim());
            });
            return urls;
        };

        // getCompany returns signed URLs; PATCH sends those back while DB has keys or pre-sign URLs.
        // Direct string compare falsely treats every document as "removed" for non-admins.
        const FOLDER_MARKERS = [
            "company-documents",
            "employee-documents",
            "asset-invoices",
            "asset-photos",
            "profile-pictures",
            "signatures",
            "rewards",
            "fines"
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

        const collectAttachmentUrlSet = (items, path = "document.url") => {
            const set = new Set();
            collectAttachmentUrls(items, path).forEach((u) => {
                const k = normalizeAttachmentKeyForCompare(u);
                if (k) set.add(k);
            });
            return set;
        };

        const isDocumentRemovalAttempt = () => {
            // Top-level required docs
            if (
                Object.prototype.hasOwnProperty.call(updateData, "tradeLicenseAttachment") &&
                beforeCompany.tradeLicenseAttachment &&
                !updateData.tradeLicenseAttachment
            ) return true;
            if (
                Object.prototype.hasOwnProperty.call(updateData, "establishmentCardAttachment") &&
                beforeCompany.establishmentCardAttachment &&
                !updateData.establishmentCardAttachment
            ) return true;

            // Array-based company documents
            const checkArrayRemoval = (field, path = "document.url") => {
                if (!Object.prototype.hasOwnProperty.call(updateData, field)) return false;
                const prev = beforeCompany[field] || [];
                const next = updateData[field] || [];
                if (next.length < prev.length) return true;
                const prevUrls = collectAttachmentUrlSet(prev, path);
                const nextUrls = collectAttachmentUrlSet(next, path);
                for (const k of prevUrls) {
                    if (!nextUrls.has(k)) return true;
                }
                return false;
            };

            if (checkArrayRemoval("documents")) return true;
            if (checkArrayRemoval("ejari")) return true;
            if (checkArrayRemoval("insurance")) return true;

            // Owner document attachments
            if (Object.prototype.hasOwnProperty.call(updateData, "owners")) {
                const ownerDocFields = ["attachment", "passport.attachment", "visa.attachment", "emiratesId.attachment", "medical.attachment", "drivingLicense.attachment", "labourCard.attachment"];
                const prevOwners = beforeCompany.owners || [];
                const nextOwners = updateData.owners || [];
                for (const field of ownerDocFields) {
                    const [p1, p2] = field.split(".");
                    const prevUrls = new Set(
                        prevOwners
                            .map((o) => (p2 ? o?.[p1]?.[p2] : o?.[p1]))
                            .filter((x) => typeof x === "string" && x.trim())
                            .map((x) => normalizeAttachmentKeyForCompare(x))
                            .filter(Boolean)
                    );
                    const nextUrls = new Set(
                        nextOwners
                            .map((o) => (p2 ? o?.[p1]?.[p2] : o?.[p1]))
                            .filter((x) => typeof x === "string" && x.trim())
                            .map((x) => normalizeAttachmentKeyForCompare(x))
                            .filter(Boolean)
                    );
                    for (const k of prevUrls) {
                        if (!nextUrls.has(k)) return true;
                    }
                }
            }
            return false;
        };

        const ownersPayloadDiffers =
            Object.prototype.hasOwnProperty.call(updateData, "owners") &&
            (() => {
                try {
                    return (
                        JSON.stringify(toSerializable(updateData.owners ?? [])) !==
                        JSON.stringify(toSerializable(beforeCompany.owners ?? []))
                    );
                } catch {
                    return true;
                }
            })();

        if (
            !requesterIsAdmin &&
            isDocumentRemovalAttempt() &&
            !isCompanyDocumentNotRenewArchive
        ) {
            const blockedNonOwnerPayload =
                !shouldTriggerCompanyReactivation(beforeCompany, updateData) && !ownersPayloadDiffers;
            if (blockedNonOwnerPayload) {
                return res.status(403).json({
                    message: "Only administrator can delete company profile documents/cards."
                });
            }
        }

        if (updateData.responsibilities && Array.isArray(updateData.responsibilities)) {
            const existingResps = company.responsibilities || [];

            const isGlobal = updateData.isGlobalFlowUpdate === true;
            const categoriesToHandle = ['hr', 'accounts', 'assetcontroller', 'management', 'admincontroller'];

            for (const cat of categoriesToHandle) {
                const existingActive = existingResps.find(r => r.category === cat && r.status === 'Active');
                const newAssignee = updateData.responsibilities.find(r => r.category === cat && (!r.status || r.status === 'Pending' || r.status === 'Active'));

                if (newAssignee && (!existingActive || existingActive.employeeId !== newAssignee.employeeId)) {
                    // Force status to Pending for new assignments to ensure employee approval flow
                    newAssignee.status = 'Pending';

                    // If there was an existing one, we KEEP it as Active for continuity until approval
                    if (existingActive && existingActive.employeeId !== newAssignee.employeeId) {
                        const isOldInNew = updateData.responsibilities.some(r => r.employeeId === existingActive.employeeId && r.category === cat && r.status === 'Active');
                        if (!isOldInNew) {
                            const oldObj = existingActive.toObject ? existingActive.toObject() : existingActive;
                            updateData.responsibilities.push({
                                ...oldObj,
                                status: 'Active'
                            });
                        }
                    }
                }
            }

            for (const resp of updateData.responsibilities) {
                if (!resp.employeeId) continue;

                // Check employee exists and has company email
                const employee = await EmployeeBasic.findOne({
                    employeeId: { $regex: new RegExp(`^${resp.employeeId}$`, 'i') }
                });
                if (!employee) {
                    return res.status(400).json({ message: `Employee ${resp.employeeId} not found` });
                }

                resp.empObjectId = employee._id;

                if (!employee.companyEmail) {
                    return res.status(400).json({
                        message: `Employee ${employee.firstName} ${employee.lastName} (${resp.employeeId}) cannot be assigned a responsibility because they do not have a company email address.`
                    });
                }

                // Check if employee is also a user
                const linkedUser = await User.findOne({ employeeId: resp.employeeId });
                if (!linkedUser) {
                    return res.status(400).json({
                        message: `Employee ${employee.firstName} ${employee.lastName} (${resp.employeeId}) cannot be assigned a responsibility because they are not registered as a system user.`
                    });
                }

                // Trigger notifications for ANY pending responsibility
                if (resp.status === 'Pending') {
                    // Check if we already have a pending dashboard action for this specific role and employee
                    const existingAction = await DashboardAction.findOne({
                        assignedTo: employee._id,
                        requestType: 'Responsibility Approval',
                        status: 'Pending',
                        extra1: resp.category
                    });

                    if (!existingAction) {
                        try {
                            const newAction = await DashboardAction.create({
                                assignedTo: employee._id,
                                assignedToEmpId: employee.employeeId,
                                requestId: company._id,
                                requestType: 'Responsibility Approval',
                                subjectEmployeeId: employee.employeeId,
                                subjectName: `${employee.firstName} ${employee.lastName}`,
                                requestedByName: req.user.name || 'Admin',
                                extra1: resp.category,
                                extra2: isGlobal ? 'All Companies' : company.name,
                                status: 'Pending',
                                isGlobal: isGlobal
                            });

                            // Role label for email
                            const roleLabels = {
                                'hr': 'HR Admin',
                                'accounts': 'Financial Controller',
                                'assetcontroller': 'Asset Controller',
                                'management': 'General Management',
                                'admincontroller': 'System Admin'
                            };

                            const emailPayload =
                                resp.category === 'assetcontroller'
                                    ? await buildResponsibilityEmailData('assetcontroller')
                                    : null;

                            await sendResponsibilityApprovalEmail({
                                employee: employee,
                                companyName: isGlobal ? 'All Companies' : company.name,
                                category: roleLabels[resp.category] || resp.category,
                                requestId: newAction._id,
                                dashboardDeepLinkId: company._id,
                                unassignedAssets: [],
                                emailData: emailPayload ? { categoryKey: resp.category, ...emailPayload } : null
                            });
                        } catch (err) {
                            console.error(`Error creating responsibility approval action/email for ${resp.category}:`, err);
                        }
                    }
                }
            }
        }

        // Queue reactivation only for critical profile changes (license/card/owner/MOA).
        // Operational docs like memo/other company documents should save immediately.
        const queueForApproval =
            !skipReactivationQueueForThisRequest && shouldTriggerCompanyReactivation(beforeCompany, updateData);
        let updatedCompany = null;
        if (queueForApproval) {
            const changedCards = collectCompanyReactivationChangeLabels(updateData);
            const cardLabel = changedCards.length ? changedCards.join(", ") : "Company Profile";
            const currentStatus = String(company?.status || "").toLowerCase();
            const currentActivation = String(company?.activationStatus || "").toLowerCase();
            if (currentStatus === "active" || currentActivation === "submitted") {
                company.status = "Inactive";
                company.activationStatus = "draft";
                company.activationSubmittedTo = null;
            }
            if (!Array.isArray(company.pendingReactivationChanges)) company.pendingReactivationChanges = [];
            company.pendingReactivationChanges.push({
                card: cardLabel,
                reason: cardLabel,
                section: "companyProfile",
                changeType: "update",
                targetIndex: null,
                previousData: toSerializable(beforeCompany),
                proposedData: toSerializable(updateData),
                changedAt: new Date(),
            });
            updatedCompany = await company.save();
        } else {
            if (!skipReactivationQueueForThisRequest) {
                await archiveSupersededCompanyDocuments(beforeCompany, updateData);
            }
            const ownerArchives = skipReactivationQueueForThisRequest
                ? []
                : archiveSupersededCompanyOwners(beforeCompany, updateData);
            const updateOps = {};
            if (Object.keys(updateData).length > 0) {
                updateOps.$set = updateData;
            }
            if (pullDocumentsByIds.length || pullOldDocumentsByIds.length || pullOwnersByIds.length) {
                if (requesterIsAdmin) {
                    await awaitAdminCompanyPullArchives(req, beforeCompany, {
                        pullDocumentsByIds,
                        pullOldDocumentsByIds,
                        pullOwnersByIds,
                    });
                }
                updateOps.$pull = {};
                if (pullDocumentsByIds.length) {
                    updateOps.$pull.documents = { _id: { $in: pullDocumentsByIds } };
                }
                if (pullOldDocumentsByIds.length) {
                    updateOps.$pull.oldDocuments = { _id: { $in: pullOldDocumentsByIds } };
                }
                if (pullOwnersByIds.length) {
                    updateOps.$pull.owners = { _id: { $in: pullOwnersByIds } };
                }
            }
            const mongoArrayFilters = [];
            if (retireLiveDocumentOid) {
                const prev = (beforeCompany.documents || []).find((d) => String(d._id) === String(retireLiveDocumentOid));
                if (prev) {
                    if (!updateOps.$set) updateOps.$set = {};
                    const prevType = prev.type || "Document";
                    const prevDesc = prev.description || "";
                    updateOps.$set["documents.$[d].type"] = `Previous ${prevType}`;
                    updateOps.$set["documents.$[d].description"] = `Deleted/Archived - ${prevDesc}`;
                    mongoArrayFilters.push({ "d._id": retireLiveDocumentOid });
                }
            }
            if (requesterIsAdmin && (clearOldOwnerDocCard || clearLiveOwnerDocCard)) {
                const clearSpec = clearLiveOwnerDocCard || clearOldOwnerDocCard;
                const ownerTarget = clearLiveOwnerDocCard ? 'owners' : 'oldOwners';
                const ownerList = clearLiveOwnerDocCard ? beforeCompany.owners : beforeCompany.oldOwners;
                const ownerRow = (ownerList || []).find(
                    (o) => String(o?._id || o?.id) === String(clearSpec.ownerId)
                );
                if (ownerRow) {
                    await archiveAdminOwnerDocCardDeletion(
                        req,
                        beforeCompany,
                        ownerRow,
                        clearSpec.docKey,
                        ownerTarget
                    );
                }
                const stripped = stripOwnerDocFromPendingReactivation(
                    beforeCompany.pendingReactivationChanges || [],
                    clearSpec.ownerId,
                    clearSpec.docKey
                );
                if (stripped !== beforeCompany.pendingReactivationChanges) {
                    if (!updateOps.$set) updateOps.$set = {};
                    updateOps.$set.pendingReactivationChanges = stripped;
                }
            }
            if (clearOldOwnerDocCard) {
                if (!updateOps.$unset) updateOps.$unset = {};
                updateOps.$unset[ownerDocUnsetPath('oldOwners', clearOldOwnerDocCard.docKey)] = 1;
                mongoArrayFilters.push({ "o._id": clearOldOwnerDocCard.ownerId });
            }
            if (clearLiveOwnerDocCard) {
                if (!updateOps.$unset) updateOps.$unset = {};
                updateOps.$unset[ownerDocUnsetPath('owners', clearLiveOwnerDocCard.docKey)] = 1;
                mongoArrayFilters.push({ "live._id": clearLiveOwnerDocCard.ownerId });
            }
            if (ownerArchives.length) {
                updateOps.$push = { oldOwners: { $each: ownerArchives } };
            }

            const findOpts = { new: true, runValidators: true, projection: COMPANY_UPDATE_READ_EXCLUSIONS };
            if (mongoArrayFilters.length) findOpts.arrayFilters = mongoArrayFilters;

            if (Object.keys(updateOps).length === 0) {
                updatedCompany = company;
            } else {
                updatedCompany = await Company.findByIdAndUpdate(company._id, updateOps, findOpts);
            }
        }

        try {
            const { reconcileCompanyDocumentExpiryDashboard } = await import(
                "../../utils/processDocumentExpiryReminders.js"
            );
            if (updatedCompany?._id) {
                await reconcileCompanyDocumentExpiryDashboard(updatedCompany._id);
            }
        } catch (reconcileErr) {
            console.warn("[updateCompany] reconcileCompanyDocumentExpiryDashboard:", reconcileErr?.message || reconcileErr);
        }

        if (!queueForApproval) {
            try {
                await markCompanyActivationHoldResolvedForUpdate(company._id.toString(), updateData);
                const refreshed = await Company.findById(company._id)
                    .select(COMPANY_UPDATE_READ_EXCLUSIONS)
                    .maxTimeMS(5000);
                if (refreshed) updatedCompany = refreshed;
            } catch (markErr) {
                console.error("[updateCompany] markCompanyActivationHoldResolvedForUpdate:", markErr);
            }
        }

        // Sync owner details across all other companies where the owner exists by name
        if (!queueForApproval && updateData.owners && Array.isArray(updateData.owners)) {
            let reconcileExpiry = null;
            try {
                const mod = await import("../../utils/processDocumentExpiryReminders.js");
                reconcileExpiry = mod.reconcileCompanyDocumentExpiryDashboard;
            } catch (_) {
                /* handled per peer below */
            }
            for (const owner of updateData.owners) {
                if (owner.name) {
                    const syncData = {};
                    if (owner.nationality !== undefined) syncData["owners.$.nationality"] = owner.nationality;
                    if (owner.attachment !== undefined) syncData["owners.$.attachment"] = owner.attachment;
                    if (owner.passport !== undefined) syncData["owners.$.passport"] = owner.passport;
                    if (owner.visa !== undefined) syncData["owners.$.visa"] = owner.visa;
                    if (owner.emiratesId !== undefined) syncData["owners.$.emiratesId"] = owner.emiratesId;
                    if (owner.medical !== undefined) syncData["owners.$.medical"] = owner.medical;
                    if (owner.drivingLicense !== undefined) syncData["owners.$.drivingLicense"] = owner.drivingLicense;
                    if (owner.labourCard !== undefined) syncData["owners.$.labourCard"] = owner.labourCard;

                    if (Object.keys(syncData).length > 0) {
                        try {
                            const peerCompanies = await Company.find({
                                _id: { $ne: updatedCompany._id },
                                "owners.name": owner.name,
                            })
                                .select("_id")
                                .lean();
                            await Company.updateMany(
                                { _id: { $ne: updatedCompany._id }, "owners.name": owner.name },
                                { $set: syncData }
                            );
                            if (reconcileExpiry) {
                                for (const p of peerCompanies) {
                                    try {
                                        await reconcileExpiry(p._id);
                                    } catch (peerReconcileErr) {
                                        console.warn(
                                            "[updateCompany] peer reconcileCompanyDocumentExpiryDashboard:",
                                            peerReconcileErr?.message || peerReconcileErr
                                        );
                                    }
                                }
                            }
                        } catch (syncErr) {
                            console.error(`Error syncing owner details for ${owner.name}:`, syncErr);
                        }
                    }
                }
            }
        }

        // Generate signed URLs for updated documents
        const companyObj = updatedCompany.toObject();

        // Core Documents
        if (companyObj.tradeLicenseAttachment) {
            companyObj.tradeLicenseAttachment = await getSignedFileUrl(companyObj.tradeLicenseAttachment);
        }
        if (companyObj.establishmentCardAttachment) {
            companyObj.establishmentCardAttachment = await getSignedFileUrl(companyObj.establishmentCardAttachment);
        }
        if (companyObj.logo) {
            companyObj.logo = await getSignedFileUrl(companyObj.logo);
        }

        // Owners Documents
        if (companyObj.owners && Array.isArray(companyObj.owners)) {
            companyObj.owners = await Promise.all(companyObj.owners.map(async (owner) => {
                if (!owner || typeof owner !== "object") return owner;
                if (owner.attachment) owner.attachment = await getSignedFileUrl(owner.attachment);
                if (owner.passport?.attachment) owner.passport.attachment = await getSignedFileUrl(owner.passport.attachment);
                if (owner.visa?.attachment) owner.visa.attachment = await getSignedFileUrl(owner.visa.attachment);
                if (owner.emiratesId?.attachment) owner.emiratesId.attachment = await getSignedFileUrl(owner.emiratesId.attachment);
                if (owner.medical?.attachment) owner.medical.attachment = await getSignedFileUrl(owner.medical.attachment);
                if (owner.drivingLicense?.attachment) owner.drivingLicense.attachment = await getSignedFileUrl(owner.drivingLicense.attachment);
                if (owner.labourCard?.attachment) owner.labourCard.attachment = await getSignedFileUrl(owner.labourCard.attachment);
                return owner;
            }));
        }

        // Archived Owners Documents
        if (companyObj.oldOwners && Array.isArray(companyObj.oldOwners)) {
            companyObj.oldOwners = await Promise.all(companyObj.oldOwners.map(async (owner) => {
                if (!owner || typeof owner !== "object") return owner;
                if (owner.attachment) owner.attachment = await getSignedFileUrl(owner.attachment);
                if (owner.passport?.attachment) owner.passport.attachment = await getSignedFileUrl(owner.passport.attachment);
                if (owner.visa?.attachment) owner.visa.attachment = await getSignedFileUrl(owner.visa.attachment);
                if (owner.emiratesId?.attachment) owner.emiratesId.attachment = await getSignedFileUrl(owner.emiratesId.attachment);
                if (owner.medical?.attachment) owner.medical.attachment = await getSignedFileUrl(owner.medical.attachment);
                if (owner.drivingLicense?.attachment) owner.drivingLicense.attachment = await getSignedFileUrl(owner.drivingLicense.attachment);
                if (owner.labourCard?.attachment) owner.labourCard.attachment = await getSignedFileUrl(owner.labourCard.attachment);
                return owner;
            }));
        }

        // Custom Documents
        if (companyObj.documents && Array.isArray(companyObj.documents)) {
            companyObj.documents = await Promise.all(companyObj.documents.map(async (doc) => {
                if (!doc || typeof doc !== "object") return doc;
                if (doc.document?.url) {
                    doc.document.url = await getSignedFileUrl(doc.document.url);
                }
                return doc;
            }));
        }

        // Insurance Records
        if (companyObj.insurance && Array.isArray(companyObj.insurance)) {
            companyObj.insurance = await Promise.all(companyObj.insurance.map(async (item) => {
                if (!item || typeof item !== "object") return item;
                if (item.document?.url) {
                    item.document.url = await getSignedFileUrl(item.document.url);
                }
                return item;
            }));
        }

        // Ejari Records
        if (companyObj.ejari && Array.isArray(companyObj.ejari)) {
            companyObj.ejari = await Promise.all(companyObj.ejari.map(async (item) => {
                if (!item || typeof item !== "object") return item;
                if (item.document?.url) {
                    item.document.url = await getSignedFileUrl(item.document.url);
                }
                return item;
            }));
        }

        // Archived Documents
        if (companyObj.oldDocuments && Array.isArray(companyObj.oldDocuments)) {
            companyObj.oldDocuments = await Promise.all(companyObj.oldDocuments.map(async (doc) => {
                if (!doc || typeof doc !== "object") return doc;
                if (doc.document?.url) {
                    doc.document.url = await getSignedFileUrl(doc.document.url);
                }
                return doc;
            }));
        }

        res.status(200).json({
            message: queueForApproval
                ? "Company change queued for HR activation approval."
                : "Company updated successfully",
            company: companyObj,
            activationProgress: calculateCompanyActivationProgress(companyObj)
        });
    } catch (error) {
        console.error("Error updating company:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};
