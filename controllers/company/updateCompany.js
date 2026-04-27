import Company from "../../models/Company.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import User from "../../models/User.js";
import DashboardAction from "../../models/DashboardAction.js";
import { sendResponsibilityApprovalEmail } from "../../utils/sendResponsibilityApprovalEmail.js";
import { buildResponsibilityEmailData } from "../../utils/flowchartResponsibilityEmailData.js";
import { getSignedFileUrl } from "../../utils/s3Upload.js";
import { calculateCompanyActivationProgress, shouldTriggerCompanyReactivation } from "../../utils/companyActivation.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";

const startOfDay = (d) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
};

const getDaysUntil = (expiryDate) => {
    if (!expiryDate) return null;
    const today = startOfDay(new Date());
    const exp = startOfDay(expiryDate);
    return Math.round((exp - today) / (1000 * 60 * 60 * 24));
};

const getReminderStageMarker = (daysUntilExpiry) => {
    if (daysUntilExpiry == null) return null;
    if (daysUntilExpiry <= 30 && daysUntilExpiry > 20) return 30;
    if (daysUntilExpiry <= 20 && daysUntilExpiry > 10) return 20;
    if (daysUntilExpiry <= 10) return 10;
    return null;
};

const buildCompanyExpiringDocs = (company) => {
    const docs = [];
    if (company?.tradeLicenseExpiry) {
        docs.push({ label: "Trade License", expiryDate: company.tradeLicenseExpiry });
    }
    if (company?.establishmentCardExpiry) {
        docs.push({ label: "Establishment Card", expiryDate: company.establishmentCardExpiry });
    }
    (company?.documents || []).forEach((d) => {
        if (!d?.expiryDate) return;
        docs.push({ label: d?.type || "Company Document", expiryDate: d.expiryDate });
    });
    (company?.ejari || []).forEach((ej) => {
        if (!ej?.expiryDate) return;
        docs.push({ label: ej?.type ? `Ejari — ${ej.type}` : "Ejari", expiryDate: ej.expiryDate });
    });
    (company?.insurance || []).forEach((ins) => {
        if (!ins?.expiryDate) return;
        docs.push({ label: ins?.type ? `Insurance — ${ins.type}` : "Insurance", expiryDate: ins.expiryDate });
    });
    const ownerFields = [
        { key: "passport", label: "Passport" },
        { key: "visa", label: "Visa" },
        { key: "emiratesId", label: "Emirates ID" },
        { key: "medical", label: "Medical Insurance" },
        { key: "drivingLicense", label: "Driving License" },
        { key: "labourCard", label: "Labour Card" },
    ];
    (company?.owners || []).forEach((owner) => {
        ownerFields.forEach((f) => {
            const exp = owner?.[f.key]?.expiryDate;
            if (!exp) return;
            docs.push({ label: `${owner?.name || "Owner"} - ${f.label}`, expiryDate: exp });
        });
    });
    return docs;
};

const cleanupCompanyExpiryNotifications = async (company) => {
    const docs = buildCompanyExpiringDocs(company);
    const allowedExtra1Set = new Set(
        docs
            .filter((doc) => getReminderStageMarker(getDaysUntil(doc.expiryDate)) === 10)
            .map((doc) => `Expiry follow-up required: ${doc.label}`)
    );
    const pending = await DashboardAction.find({
        requestId: company._id,
        requestType: "Document Expiry Reminder",
        status: "Pending",
    })
        .select("_id extra1")
        .lean();
    const staleIds = pending
        .filter((row) => {
            const extra1 = (row?.extra1 || "").trim();
            if (!extra1.toLowerCase().startsWith("expiry follow-up required:")) return false;
            return !allowedExtra1Set.has(extra1);
        })
        .map((row) => row._id);
    if (staleIds.length > 0) {
        await DashboardAction.deleteMany({ _id: { $in: staleIds } });
    }
};

const collectCompanyReactivationChanges = (updateData = {}) => {
    const changes = [];
    const hasAny = (keys) => keys.some((k) => Object.prototype.hasOwnProperty.call(updateData, k));

    if (hasAny(["name", "nickName", "email", "phone", "establishedDate"])) {
        changes.push("Basic Details");
    }
    if (hasAny(["tradeLicenseNumber", "tradeLicenseIssueDate", "tradeLicenseExpiry", "tradeLicenseAttachment"])) {
        changes.push("Trade License");
    }
    if (hasAny(["establishmentCardNumber", "establishmentCardIssueDate", "establishmentCardExpiry", "establishmentCardAttachment"])) {
        changes.push("Establishment Card");
    }
    if (Object.prototype.hasOwnProperty.call(updateData, "documents")) {
        const docs = Array.isArray(updateData.documents) ? updateData.documents : [];
        if (docs.some((d) => String(d?.type || "").toLowerCase().includes("moa"))) {
            changes.push("MOA");
        }
    }

    return [...new Set(changes)];
};

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

export const updateCompany = async (req, res) => {
    try {
        const { id } = req.params;

        // Find by _id or companyId
        let company = await Company.findOne({
            $or: [{ _id: id.match(/^[0-9a-fA-F]{24}$/) ? id : null }, { companyId: id }]
        });

        if (!company) {
            return res.status(404).json({ message: "Company not found" });
        }

        // Update fields provided in req.body
        const updateData = req.body;
        const beforeCompany = company.toObject();
        const requesterIsAdmin = await isReqUserAdmin(req.user);

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

        if (!requesterIsAdmin && isDocumentRemovalAttempt()) {
            return res.status(403).json({
                message: "Only administrator can delete company profile documents/cards."
            });
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
        const queueForApproval = shouldTriggerCompanyReactivation(beforeCompany, updateData);
        let updatedCompany = null;
        if (queueForApproval) {
            const changedCards = collectCompanyReactivationChanges(updateData);
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
            updatedCompany = await Company.findByIdAndUpdate(
                company._id,
                { $set: updateData },
                { new: true, runValidators: true }
            );
        }

        // Remove stale expiry reminder notifications immediately after any company document/card edit.
        if (!queueForApproval) {
            await cleanupCompanyExpiryNotifications(updatedCompany);
        }

        // Sync owner details across all other companies where the owner exists by name
        if (!queueForApproval && updateData.owners && Array.isArray(updateData.owners)) {
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
                            await Company.updateMany(
                                { _id: { $ne: updatedCompany._id }, "owners.name": owner.name },
                                { $set: syncData }
                            );
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
