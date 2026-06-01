import Company from "../../models/Company.js";
import DashboardAction from "../../models/DashboardAction.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { isRequestUserDesignatedFlowchartHr } from "../../utils/isDesignatedFlowchartHr.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";
import {
    calculateCompanyActivationProgress,
    submitCompanyActivation,
    companyWasEverFullyActivated,
} from "../../utils/companyActivation.js";
import { syncDashboardAction } from "../../utils/syncDashboard.js";
import { clearAllCompanyActivationDashboardRows } from "../../utils/clearCompanyActivationHoldDashboardRows.js";
import { formatActivationAttachmentLine, shortenUrlsInString } from "../../utils/shortenUrlsInString.js";
import { sendCompanyActivationHoldEmail } from "../../utils/sendCompanyActivationHoldEmail.js";
import { sanitizeActivationHoldRowNotes } from "../../utils/sanitizeActivationHoldRowNotes.js";
import { sendCompanyActivationOutcomeEmail } from "../../utils/sendCompanyActivationOutcomeEmail.js";
import {
    applyCompanyProposedActivationPatch,
    companyPendingEntryId,
    loadCompanyFullProfile,
    upsertCompanyPartitions,
    clearCompanyWorkflowActivationHold,
} from "../../services/companyPartitionService.js";
import CompanyOwners from "../../models/CompanyOwners.js";

const resolveCompanyById = async (id) => {
    return Company.findOne({
        $or: [{ _id: id.match(/^[0-9a-fA-F]{24}$/) ? id : null }, { companyId: id }],
    }).maxTimeMS(15000);
};

/**
 * Resolve company for activation flows, but drop the heaviest snapshot fields
 * (oldDocuments / activationHold.snapshot / pendingReactivationChanges.previousData)
 * so the read doesn't blow past socketTimeout on flaky network nodes.
 * `oldOwners` stays loaded because the archive dedupe needs it and it's small.
 */
const ACTIVATION_HEAVY_EXCLUSIONS = {
    oldDocuments: 0,
    "activationHold.snapshot": 0,
    "pendingReactivationChanges.previousData": 0,
};
const resolveCompanyForActivation = async (id) => {
    return Company.findOne({
        $or: [{ _id: id.match(/^[0-9a-fA-F]{24}$/) ? id : null }, { companyId: id }],
    })
        .select(ACTIVATION_HEAVY_EXCLUSIONS)
        .maxTimeMS(15000);
};

/** Resolves submitter EmployeeBasic for emails and submitter dashboard rows (activationSubmittedBy first, then requester Dashboard row). */
const resolveCompanyActivationSubmitterEmployee = async (company, pendingDashboardRows = []) => {
    const selectFields = "companyEmail firstName lastName employeeId _id";

    const findEmpByIdOrUserId = async (rawId) => {
        if (!rawId) return null;
        let emp = await EmployeeBasic.findById(String(rawId)).select(selectFields).lean();
        if (emp) return emp;
        const sid = String(rawId);
        if (!/^[0-9a-fA-F]{24}$/.test(sid)) return null;
        const User = (await import("../../models/User.js")).default;
        const user = await User.findById(sid).select("employeeId").lean();
        if (!user?.employeeId) return null;
        emp = await EmployeeBasic.findOne({ employeeId: user.employeeId }).select(selectFields).lean();
        return emp || null;
    };

    if (company?.activationSubmittedBy) {
        const fromField = await findEmpByIdOrUserId(company.activationSubmittedBy);
        if (fromField) return fromField;
    }

    const rows = Array.isArray(pendingDashboardRows) ? pendingDashboardRows : [];
    for (const row of rows) {
        let role = null;
        try {
            role = JSON.parse(row.extra3 || "{}")?.companyActivationViewerRole || null;
        } catch {
            /* ignore */
        }
        if (role === "requester" && row.assignedTo) {
            const fromRow = await findEmpByIdOrUserId(row.assignedTo);
            if (fromRow) return fromRow;
        }
    }

    return null;
};

const ACTIVATION_PROCESSOR_DENIED =
    "Only designated Flowchart HR, system super user, or portal administrator can process company activation.";

const canProcessCompanyActivation = async (req) => {
    if (await isRequestUserDesignatedFlowchartHr(req)) return true;
    if (await isReqUserAdmin(req.user)) return true;
    const groupOrRole = String(req.user?.groupName || req.user?.role || "").trim();
    if (/^admin(istrator)?$/i.test(groupOrRole)) return true;
    return false;
};

export const submitCompanyActivationRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const { reason, description, attachment, attachmentName } = req.body || {};
        const selectionProvided = req.body?.selectionProvided === true;
        const includedChangeEntryIds = Array.isArray(req.body?.includedChangeEntryIds)
            ? req.body.includedChangeEntryIds.map(String)
            : null;
        const company = await resolveCompanyForActivation(id);
        if (!company) return res.status(404).json({ message: "Company not found" });

        const mergedForProgress =
            (await loadCompanyFullProfile(company)) ||
            (typeof company.toObject === "function" ? company.toObject() : company);
        const progressQuick = calculateCompanyActivationProgress(mergedForProgress);
        const isDesignatedHr = await isRequestUserDesignatedFlowchartHr(req);
        if (isDesignatedHr) {
            if (progressQuick.percentage < 100) {
                return res.status(400).json({
                    message: "Company profile is not 100% complete for activation.",
                    activationProgress: progressQuick,
                });
            }
            req.body = {
                ...(typeof req.body === "object" && req.body ? req.body : {}),
                approvedChangeIds: [],
                selectionProvided: false,
            };
            return approveCompanyActivationRequest(req, res);
        }

        if (!reason || !String(reason).trim() || !description || !String(description).trim()) {
            return res.status(400).json({
                message: "Reason and description are required for activation submission.",
            });
        }

        const reasonText = String(reason).trim();
        const descriptionText = String(description).trim();
        const rawAtt = attachment != null ? String(attachment).trim() : "";
        const attachmentLineFull = rawAtt ? `Attachment: ${rawAtt}` : null;
        const attachmentLineShort =
            formatActivationAttachmentLine(attachment, attachmentName) ||
            (rawAtt ? shortenUrlsInString(`Attachment: ${rawAtt}`) : null);

        const combinedFull = `Reason: ${reasonText}${descriptionText ? ` | Description: ${descriptionText}` : ""}${attachmentLineFull ? ` | ${attachmentLineFull}` : ""}`;
        const combinedDashboard = `Reason: ${reasonText}${descriptionText ? ` | Description: ${descriptionText}` : ""}${attachmentLineShort ? ` | ${attachmentLineShort}` : ""}`;
        const dashboardSummary = shortenUrlsInString(combinedDashboard);

        const result = await submitCompanyActivation({
            companyId: company._id,
            actor: req.user,
            reason: reasonText,
            workflowComment: combinedFull,
            description: descriptionText,
            attachment: rawAtt,
            attachmentName: attachmentName ? String(attachmentName).trim() : "",
            dashboardSummary,
            force: false,
            selectionProvided,
            includedChangeEntryIds,
        });

        if (!result.ok) {
            const status = result.blocked ? 400 : 500;
            return res.status(status).json({
                message: result.message,
                activationProgress:
                    result.progress ||
                    calculateCompanyActivationProgress(mergedForProgress),
            });
        }

        const refreshedCore = await Company.findById(company._id)
            .select(ACTIVATION_HEAVY_EXCLUSIONS)
            .maxTimeMS(15000);
        const refreshed =
            (await loadCompanyFullProfile(refreshedCore)) ||
            (typeof refreshedCore?.toObject === "function" ? refreshedCore.toObject() : refreshedCore);
        return res.status(200).json({
            message: "Company sent for HR activation review successfully.",
            company: refreshed,
            activationProgress: calculateCompanyActivationProgress(refreshed),
        });
    } catch (error) {
        console.error("submitCompanyActivationRequest error:", error);
        return res.status(500).json({ message: error.message || "Failed to submit company activation request" });
    }
};

export const approveCompanyActivationRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const approvedChangeIds = Array.isArray(req.body?.approvedChangeIds) ? req.body.approvedChangeIds.map(String) : [];
        const selectionProvided = req.body?.selectionProvided === true;
        // Light read: skips oldDocuments + previousData + activationHold.snapshot.
        // Without this, a company with a long doc history could not be loaded over
        // the flaky Atlas node (socket would time out before the doc finished streaming).
        const company = await resolveCompanyForActivation(id);
        if (!company) return res.status(404).json({ message: "Company not found" });

        if (!(await canProcessCompanyActivation(req))) {
            return res.status(403).json({
                message: ACTIVATION_PROCESSOR_DENIED,
            });
        }

        const merged =
            (await loadCompanyFullProfile(company)) ||
            (typeof company.toObject === "function" ? company.toObject() : company);
        const pendingChanges = Array.isArray(merged.pendingReactivationChanges)
            ? merged.pendingReactivationChanges.map((entry) => (entry?.toObject ? entry.toObject() : entry))
            : [];
        if (selectionProvided && pendingChanges.length > 0) {
            const expSorted = [...pendingChanges.map((entry, idx) => companyPendingEntryId(entry, idx))].sort();
            const aprSorted = [...approvedChangeIds.map(String)].sort();
            if (expSorted.length !== aprSorted.length || expSorted.join(",") !== aprSorted.join(",")) {
                return res.status(400).json({
                    message:
                        "Accept requires all requested change rows checked, or use Hold when only some are acceptable.",
                });
            }
        }
        const selectedChanges = pendingChanges.filter((entry, idx) => {
            const entryId = companyPendingEntryId(entry, idx);
            if (!selectionProvided) return true;
            return approvedChangeIds.includes(entryId);
        });

        const ownerArchivesToPush = [];
        for (const change of selectedChanges) {
            const proposedData = change?.proposedData;
            if (!proposedData || typeof proposedData !== "object") continue;
            const { ownerArchivesToPush: archives } = await applyCompanyProposedActivationPatch(
                company._id,
                proposedData,
            );
            if (archives?.length) ownerArchivesToPush.push(...archives);
        }

        company.status = "Active";
        company.activationStatus = "active";
        await company.save();

        const activationWorkflow = Array.isArray(merged.activationWorkflow) ? [...merged.activationWorkflow] : [];
        activationWorkflow.push({
            role: "HR",
            assignedTo: req.user?._id || null,
            status: "active",
            assignedAt: new Date(),
            actionedAt: new Date(),
            comment: "Company activation approved",
        });
        await upsertCompanyPartitions(company._id, {
            pendingReactivationChanges: [],
            activationWorkflow,
        });
        await clearCompanyWorkflowActivationHold(company._id);

        if (ownerArchivesToPush.length > 0) {
            try {
                const ownersDoc = await CompanyOwners.findOne({ company: company._id });
                if (ownersDoc) {
                    ownersDoc.oldOwners = [...(ownersDoc.oldOwners || []), ...ownerArchivesToPush];
                    await ownersDoc.save();
                } else {
                    await CompanyOwners.create({
                        company: company._id,
                        owners: [],
                        oldOwners: ownerArchivesToPush,
                    });
                }
            } catch (archiveErr) {
                console.error("[approveCompanyActivationRequest] Owner archive push error:", archiveErr);
            }
        }

        const pendingRowsForSubmitter = await DashboardAction.find({
            requestId: company._id,
            requestType: "Company Activation",
            status: { $in: ["Pending", "On Hold"] },
        }).lean().maxTimeMS(6000);
        const submitterEmp = await resolveCompanyActivationSubmitterEmployee(company, pendingRowsForSubmitter);

        await Company.updateOne(
            { _id: company._id },
            { $unset: { activationHold: 1, activationSubmittedBy: 1 } },
        );

        try {
            await clearAllCompanyActivationDashboardRows(company._id);
        } catch (syncErr) {
            console.error("[approveCompanyActivationRequest] Dashboard sync error:", syncErr);
        }

        try {
            await sendCompanyActivationOutcomeEmail({
                recipientEmployee: submitterEmp,
                companyName: company.name,
                companyCode: company.companyId || "",
                companyMongoId: company._id.toString(),
                manager: req.user,
                status: "approved",
            });
        } catch (mailErr) {
            console.error("[approveCompanyActivationRequest] Outcome email error:", mailErr);
        }

        const refreshed =
            (await loadCompanyFullProfile(company)) ||
            (typeof company.toObject === "function" ? company.toObject() : company);
        return res.status(200).json({
            message: "Company activation approved successfully.",
            company: refreshed,
            activationProgress: calculateCompanyActivationProgress(refreshed),
        });
    } catch (error) {
        console.error("approveCompanyActivationRequest error:", error);
        return res.status(500).json({ message: error.message || "Failed to approve company activation request" });
    }
};

export const holdCompanyActivationRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const approvedChangeIds = Array.isArray(req.body?.approvedChangeIds) ? req.body.approvedChangeIds.map(String) : [];
        const selectionProvided = req.body?.selectionProvided === true;
        const comment = String(req.body?.comment || "").trim();
        const company = await resolveCompanyForActivation(id);
        if (!company) return res.status(404).json({ message: "Company not found" });

        if (!(await canProcessCompanyActivation(req))) {
            return res.status(403).json({
                message: ACTIVATION_PROCESSOR_DENIED,
            });
        }

        if (String(company.activationStatus || "").toLowerCase() !== "submitted") {
            return res.status(400).json({ message: "Company activation is not awaiting HR review." });
        }

        const merged =
            (await loadCompanyFullProfile(company)) ||
            (typeof company.toObject === "function" ? company.toObject() : company);
        const pendingChanges = Array.isArray(merged.pendingReactivationChanges)
            ? merged.pendingReactivationChanges.map((entry, idx) => {
                const o = entry?.toObject ? entry.toObject() : entry;
                return { ...o, __idStr: companyPendingEntryId(o, idx) };
            })
            : [];

        if (!selectionProvided) {
            return res.status(400).json({
                message: "Confirm your selection, then Hold returns unchecked items to the submitter.",
            });
        }

        const allIds = pendingChanges.map((e) => e.__idStr);
        if (!allIds.length) {
            return res.status(400).json({
                message: "There are no structured change rows to hold. Accept or reject the request instead.",
            });
        }

        const invalid = approvedChangeIds.filter((x) => !allIds.includes(String(x)));
        if (invalid.length) {
            return res.status(400).json({ message: "Approved selection references unknown rows." });
        }

        const approvedChoice = new Set(approvedChangeIds);
        const numRowsAccepted = allIds.filter((rowId) => approvedChoice.has(rowId)).length;
        if (numRowsAccepted >= allIds.length) {
            return res.status(400).json({
                message: "Nothing left to hold. Use Accept when every change is acceptable.",
            });
        }

        const unapproved = pendingChanges.filter((e) => !approvedChoice.has(e.__idStr));
        const unapprovedCards = [...new Set(unapproved.map((e) => String(e.card || "").trim()).filter(Boolean))];
        const rowNotesByEntryId = sanitizeActivationHoldRowNotes(req.body?.rowNotesByEntryId, unapproved.map((e) => e.__idStr));

        const activationHold = {
            heldAt: new Date(),
            unapprovedEntryIds: unapproved.map((e) => e.__idStr),
            unapprovedCards: unapprovedCards.length ? unapprovedCards : unapproved.map((_, i) => `Change ${i + 1}`),
            comment,
            resolvedEntryIds: [],
            addressedLabelsByEntryId: {},
            ...(rowNotesByEntryId ? { rowNotesByEntryId } : {}),
        };

        await upsertCompanyPartitions(company._id, { activationHold });

        const holdNotice = `[Company profile] On hold — update: ${activationHold.unapprovedCards.join(", ")}`;

        const pendingDashboardRows = await DashboardAction.find({
            requestId: company._id,
            requestType: "Company Activation",
            status: "Pending",
        }).lean().maxTimeMS(6000);

        const submitterEmp = await resolveCompanyActivationSubmitterEmployee(company, pendingDashboardRows);

        const mailTo = submitterEmp?.companyEmail || "";
        const mailName = `${submitterEmp?.firstName || ""} ${submitterEmp?.lastName || ""}`.trim();

        if (submitterEmp?._id) {
            try {
                await syncDashboardAction({
                    requestId: company._id,
                    requestType: "Company Activation",
                    assignedTo: String(company.activationSubmittedTo || ""),
                    status: "On Hold",
                    skipPendingCompletion: true,
                    subjectEmployee: {
                        _id: company._id,
                        firstName: company.name,
                        lastName: "",
                        employeeId: company.companyId,
                    },
                    companyActivationNotifyAssignee: submitterEmp,
                    requestedByName: req.user?.name || "",
                    actionedBy: req.user?.employeeObjectId || req.user?._id,
                    comment: comment || company.activationHold.unapprovedCards.join(", "),
                    extra1: holdNotice.slice(0, 950),
                    extra2: company.companyId || "",
                    extra3: JSON.stringify({
                        companyActivationViewerRole: "submitter",
                        activationSubject: "company",
                    }),
                });
            } catch (syncErr) {
                console.error("[holdCompanyActivationRequest] Dashboard sync error:", syncErr);
            }
        }

        if (company.activationSubmittedTo) {
            try {
                await DashboardAction.deleteMany({
                    requestId: company._id,
                    requestType: "Company Activation",
                    status: "Pending",
                    assignedTo: company.activationSubmittedTo,
                });
            } catch (_e) {
                /* non-fatal */
            }
        }

        try {
            const holdNotesMap = rowNotesByEntryId || {};
            const holdLineItems = unapproved.map((e) => ({
                cardLabel: String(e.card || "").trim() || `Change (${e.__idStr})`,
                note: holdNotesMap[e.__idStr] || "",
            }));
            await sendCompanyActivationHoldEmail({
                recipientEmail: mailTo,
                recipientName: mailName,
                companyName: company.name,
                companyCode: company.companyId,
                companyPageId: company._id.toString(),
                hrManager: req.user,
                unapprovedCards: company.activationHold.unapprovedCards || [],
                holdLineItems,
                comment,
            });
        } catch (mailErr) {
            console.error("[holdCompanyActivationRequest] Hold email error:", mailErr);
        }

        const refreshedCore = await Company.findById(company._id)
            .select(ACTIVATION_HEAVY_EXCLUSIONS)
            .maxTimeMS(15000);
        const refreshed =
            (await loadCompanyFullProfile(refreshedCore)) ||
            (typeof refreshedCore?.toObject === "function" ? refreshedCore.toObject() : refreshedCore);
        return res.status(200).json({
            message: "Company activation placed on hold. The submitter was notified to update the listed items.",
            company: refreshed,
            activationProgress: calculateCompanyActivationProgress(refreshed),
        });
    } catch (error) {
        console.error("holdCompanyActivationRequest error:", error);
        return res.status(500).json({ message: error.message || "Failed to hold company activation request" });
    }
};

export const rejectCompanyActivationRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body || {};
        if (!reason || !String(reason).trim()) {
            return res.status(400).json({ message: "Rejection reason is required." });
        }
        const reasonText = String(reason).trim();
        const company = await resolveCompanyForActivation(id);
        if (!company) return res.status(404).json({ message: "Company not found" });

        if (!(await canProcessCompanyActivation(req))) {
            return res.status(403).json({
                message: ACTIVATION_PROCESSOR_DENIED,
            });
        }

        const keepActiveProfile = companyWasEverFullyActivated(company);
        company.status = keepActiveProfile ? "Active" : "Inactive";
        company.activationStatus = keepActiveProfile ? "active" : "rejected";
        const merged =
            (await loadCompanyFullProfile(company)) ||
            (typeof company.toObject === "function" ? company.toObject() : company);

        if (keepActiveProfile) {
            await upsertCompanyPartitions(company._id, { pendingReactivationChanges: [] });
        }
        const activationWorkflow = Array.isArray(merged.activationWorkflow) ? [...merged.activationWorkflow] : [];
        activationWorkflow.push({
            role: "HR",
            assignedTo: req.user?._id || null,
            status: "rejected",
            assignedAt: new Date(),
            actionedAt: new Date(),
            comment: reasonText,
        });
        company.status = keepActiveProfile ? "Active" : "Inactive";
        company.activationStatus = keepActiveProfile ? "active" : "rejected";
        await company.save();
        await upsertCompanyPartitions(company._id, { activationWorkflow });
        await clearCompanyWorkflowActivationHold(company._id);

        const pendingRowsForSubmitter = await DashboardAction.find({
            requestId: company._id,
            requestType: "Company Activation",
            status: { $in: ["Pending", "On Hold"] },
        }).lean().maxTimeMS(6000);
        const submitterEmp = await resolveCompanyActivationSubmitterEmployee(company, pendingRowsForSubmitter);

        await Company.updateOne(
            { _id: company._id },
            { $unset: { activationHold: 1, activationSubmittedBy: 1 } },
        );

        if (submitterEmp?._id) {
            try {
                await syncDashboardAction({
                    requestId: company._id,
                    requestType: "Company Activation",
                    assignedTo: String(submitterEmp._id),
                    status: "Rejected",
                    skipPendingCompletion: true,
                    subjectEmployee: {
                        _id: company._id,
                        firstName: company.name,
                        lastName: "",
                        employeeId: company.companyId,
                    },
                    companyActivationNotifyAssignee: submitterEmp,
                    requestedByName: req.user?.name || "",
                    actionedBy: req.user?.employeeObjectId || req.user?._id,
                    comment: reasonText,
                    extra2: company.companyId || "",
                    extra3: JSON.stringify({
                        companyActivationViewerRole: "submitter",
                        activationSubject: "company",
                    }),
                });
            } catch (syncErr) {
                console.error("[rejectCompanyActivationRequest] Dashboard sync error:", syncErr);
            }
        }

        try {
            const DashboardAction = (await import("../../models/DashboardAction.js")).default;
            const closeQuery = {
                requestId: company._id,
                requestType: "Company Activation",
                status: { $in: ["Pending", "On Hold"] },
            };
            if (submitterEmp?._id) {
                closeQuery.assignedTo = { $ne: submitterEmp._id };
            }
            await DashboardAction.updateMany(closeQuery, {
                status: "Rejected",
                actionedDate: new Date(),
                actionedBy: req.user?.employeeObjectId || req.user?._id,
                comment: reasonText,
            });
        } catch (syncErr) {
            console.error("[rejectCompanyActivationRequest] Dashboard update error:", syncErr);
        }


        try {
            await sendCompanyActivationOutcomeEmail({
                recipientEmployee: submitterEmp,
                companyName: company.name,
                companyCode: company.companyId || "",
                companyMongoId: company._id.toString(),
                manager: req.user,
                status: "rejected",
                reason: reasonText,
            });
        } catch (mailErr) {
            console.error("[rejectCompanyActivationRequest] Outcome email error:", mailErr);
        }

        const refreshed =
            (await loadCompanyFullProfile(company)) ||
            (typeof company.toObject === "function" ? company.toObject() : company);
        return res.status(200).json({
            message: "Company activation rejected.",
            company: refreshed,
            activationProgress: calculateCompanyActivationProgress(refreshed),
        });
    } catch (error) {
        console.error("rejectCompanyActivationRequest error:", error);
        return res.status(500).json({ message: error.message || "Failed to reject company activation request" });
    }
};
