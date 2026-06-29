import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getCompleteEmployee } from "../../services/employeeService.js";
import { sendProfileNotification } from "../../utils/sendProfileNotification.js";
import { syncDashboardAction } from "../../utils/syncDashboard.js";
import { resolveProfileActivationSubmitterEmployee } from "../../utils/resolveProfileActivationSubmitterEmployee.js";
import {
    buildProfileActivationEntityLine,
    buildProfileActivationRejectedMessage,
    employeeProfileDisplayName,
} from "../../utils/employeeProfileNotificationMessages.js";
import { isEmployeeProfileActivationDesignatedHr } from "../../utils/isEmployeeProfileActivationDesignatedHr.js";
import {
    closeLeftUserDashboardTasks,
    pendingChangesIncludeLeftUser,
} from "../../utils/employeeLeftUserWorkflow.js";
import { resolveEmployeeProfileStatusWrite } from "../../utils/employeeProfileStatusLock.js";
import { revertAllPendingEmployeeChanges } from "../../utils/revertPendingEmployeeProfileChange.js";

export const rejectProfile = async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;
    if (!reason || reason.trim().length === 0) {
        return res.status(400).json({ message: "Reason for rejection is mandatory." });
    }

    try {
        // Get employee record
        const employee = await getCompleteEmployee(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        if (!(await isEmployeeProfileActivationDesignatedHr(req, employee))) {
            return res.status(403).json({
                message: "Only designated HR or an administrator can reject this activation request.",
            });
        }

        const employeeId = employee.employeeId;

        const hadLeftUserPending = pendingChangesIncludeLeftUser(employee.pendingReactivationChanges);

        const basicDoc = await EmployeeBasic.findOne({ employeeId });
        if (basicDoc && Array.isArray(basicDoc.pendingReactivationChanges) && basicDoc.pendingReactivationChanges.length > 0) {
            const pendingPlain = basicDoc.pendingReactivationChanges.map((entry) =>
                typeof entry?.toObject === "function" ? entry.toObject() : { ...entry },
            );
            await revertAllPendingEmployeeChanges(employeeId, basicDoc, pendingPlain);
            await basicDoc.save();
        }

        const DashboardAction = (await import("../../models/DashboardAction.js")).default;
        const pendingRowsForSubmitter = await DashboardAction.find({
            requestId: employee._id,
            requestType: "Profile Activation",
            status: { $in: ["Pending", "On Hold"] },
        })
            .lean()
            .maxTimeMS(6000);

        const submitterForNotify = await resolveProfileActivationSubmitterEmployee(
            employee,
            pendingRowsForSubmitter,
        );

        const wasPreviouslyActive = Array.isArray(employee.profileWorkflow)
            ? employee.profileWorkflow.some((w) => String(w?.status || "").toLowerCase() === "active")
            : false;
        const keepActiveProfile =
            wasPreviouslyActive || String(employee.profileStatus || "").toLowerCase() === "active";

        const updated = await EmployeeBasic.findOneAndUpdate(
            { employeeId },
            {
                profileApprovalStatus: keepActiveProfile ? "active" : "rejected",
                profileStatus: resolveEmployeeProfileStatusWrite(
                    employee,
                    keepActiveProfile ? "active" : "inactive",
                ),
                $unset: {
                    profileActivationHold: 1,
                    profileActivationSubmittedBy: 1,
                    profileActivationDraftEditor: 1,
                },
                $set: {
                    pendingReactivationChanges: [],
                    "profileWorkflow.$[elem].status": "rejected",
                    "profileWorkflow.$[elem].actionedAt": new Date(),
                    "profileWorkflow.$[elem].comment": reason || "Profile activation request rejected."
                }
            },
            {
                new: true,
                arrayFilters: [{ "elem.status": "submitted" }] // Update only the submitted entry
            }
        );

        if (!updated) {
            return res.status(404).json({ message: "Employee submission not found" });
        }

        const subjectLean = await EmployeeBasic.findOne({ employeeId })
            .select("_id employeeId firstName lastName designation companyEmail workEmail email personalEmail")
            .lean();

        let submitterForEmail = submitterForNotify;
        if (submitterForNotify?._id) {
            submitterForEmail = await EmployeeBasic.findById(submitterForNotify._id)
                .select("_id employeeId firstName lastName designation companyEmail workEmail email personalEmail primaryReportee")
                .populate("primaryReportee", "firstName lastName companyEmail workEmail email")
                .lean();
        }

        if (submitterForNotify?._id) {
            try {
                const rejectedName = employeeProfileDisplayName(subjectLean || updated);
                await syncDashboardAction({
                    requestId: updated._id,
                    requestType: "Profile Activation",
                    assignedTo: String(submitterForNotify._id),
                    status: "Rejected",
                    skipPendingCompletion: true,
                    subjectEmployee: subjectLean || updated,
                    profileActivationNotifyAssignee: submitterForNotify,
                    requestedByName: req.user?.name || "",
                    actionedBy: req.user?.employeeObjectId || req.user?._id,
                    comment: reason || "",
                    extra1: buildProfileActivationRejectedMessage({
                        employeeName: rejectedName,
                        employeeId: updated.employeeId,
                    }),
                    extra2: buildProfileActivationEntityLine(rejectedName, updated.employeeId),
                    extra3: JSON.stringify({
                        activationSubject: "employee",
                        activationViewerRole: "submitter",
                    }),
                });
            } catch (syncErr) {
                console.error("[RejectProfile] Dashboard Sync Error:", syncErr);
            }
        }

        // Close HR / interim rows (submitter outcome row is upserted above).
        try {
            const closeQuery = {
                requestId: updated._id,
                requestType: "Profile Activation",
                status: { $in: ["Pending", "On Hold"] },
            };
            if (submitterForNotify?._id) {
                closeQuery.assignedTo = { $ne: submitterForNotify._id };
            }
            await DashboardAction.updateMany(closeQuery, {
                status: "Rejected",
                actionedDate: new Date(),
                actionedBy: req.user?.employeeObjectId || req.user?._id,
                comment: reason || "",
            });
        } catch (syncErr) {
            console.error("[RejectProfile] Dashboard Update Error:", syncErr);
        }

        if (hadLeftUserPending) {
            try {
                await closeLeftUserDashboardTasks({
                    employeeMongoId: updated._id,
                    status: "Rejected",
                    actionedBy: req.user?.employeeObjectId || req.user?._id,
                    comment: reason || "",
                });
            } catch (syncErr) {
                console.error("[RejectProfile] Left User dashboard sync:", syncErr);
            }
        }

        // Get complete employee data for response
        const completeEmployee = await getCompleteEmployee(employeeId);
        const recipientForActivationEmail = submitterForEmail;

        // Trigger Email Notification (Background)
        const manager = req.user; // The person who rejected
        sendProfileNotification({
            employee: completeEmployee,
            recipientEmployee: recipientForActivationEmail,
            manager: manager,
            status: 'rejected',
            reason: reason || "Profile activation request rejected. Please review your details."
        }).catch(err => console.error("Async Email Error:", err));

        delete completeEmployee.password;

        return res.status(200).json({
            message: "Employee profile activation rejected.",
            employee: completeEmployee
        });
    } catch (error) {
        console.error("Failed to reject profile:", error);
        return res.status(500).json({ message: error.message || "Failed to reject profile." });
    }
};
