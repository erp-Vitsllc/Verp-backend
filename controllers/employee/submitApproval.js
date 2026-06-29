import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getCompleteEmployee } from "../../services/employeeService.js";
import { resolveFlowchartHrEmployee } from "../../utils/resolveFlowchartHrEmployee.js";
import { resolveProfileActivationSubmitterId } from "../../utils/resolveProfileActivationSubmitterId.js";
import { notifyHrProfileActivationRequestEmail } from "../../utils/notifyHrProfileActivationRequestEmail.js";
import { clearProfileActivationHoldDashboardRows } from "../../utils/clearProfileActivationHoldDashboardRows.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";
import {
    buildProfileActivationEntityLine,
    buildProfileActivationPendingMessage,
    employeeProfileDisplayName,
} from "../../utils/employeeProfileNotificationMessages.js";

export const submitApproval = async (req, res) => {
    const { id } = req.params;

    try {
        const employeeBasic = await getCompleteEmployee(id);
        if (!employeeBasic) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const submitterEmployeeId = await resolveProfileActivationSubmitterId(req);
        if (!submitterEmployeeId) {
            return res.status(400).json({
                message:
                    "Your portal login must be linked to an Employee record before you can submit for activation. Check user → employee mapping or employee ID on your account.",
            });
        }

        const hrResolved = await resolveFlowchartHrEmployee();
        if (hrResolved.error) {
            return res.status(400).json({
                message: hrResolved.message,
                code: hrResolved.error
            });
        }

        const hrEmployee = hrResolved.employee;
        const hrEmail = hrResolved.email;
        const employeeId = employeeBasic.employeeId;
        const wasPreviouslyActive = Array.isArray(employeeBasic.profileWorkflow)
            ? employeeBasic.profileWorkflow.some((w) => String(w?.status || "").toLowerCase() === "active")
            : false;
        const activationTypeLabel = wasPreviouslyActive ? "Reactivation" : "New Activation";
        const pendingCards = Array.isArray(employeeBasic.pendingReactivationChanges)
            ? [...new Set(employeeBasic.pendingReactivationChanges.map((x) => String(x?.card || "").trim()).filter(Boolean))]
            : [];
        const pendingCardsText = pendingCards.length ? ` | Requested Changes: ${pendingCards.join(", ")}` : "";
        const isAdminSubmitter = await isReqUserAdmin(req.user);

        const updated = await EmployeeBasic.findOneAndUpdate(
            { employeeId },
            {
                $set: {
                    profileApprovalStatus: "submitted",
                    profileSubmittedTo: hrEmployee._id,
                    profileActivationSubmittedBy: submitterEmployeeId,
                },
                $push: {
                    profileWorkflow: {
                        role: "HR",
                        assignedTo: hrEmployee._id,
                        status: "submitted",
                        assignedAt: new Date(),
                    },
                },
            },
            { new: true }
        );

        if (!updated) {
            return res.status(404).json({ message: "Employee not found" });
        }

        try {
            const { syncDashboardAction } = await import("../../utils/syncDashboard.js");
            const dashboardEmployeeName = employeeProfileDisplayName(updated);
            const activationExtra1 = buildProfileActivationPendingMessage({
                employeeName: dashboardEmployeeName,
                employeeId: updated.employeeId,
                activationType: activationTypeLabel,
                submittedBy:
                    req.user?.name ||
                    [req.user?.firstName, req.user?.lastName].filter(Boolean).join(" ").trim() ||
                    (isAdminSubmitter ? "Administrator" : ""),
                pendingCards,
            });
            await syncDashboardAction({
                requestId: updated._id,
                requestType: "Profile Activation",
                assignedTo: String(hrEmployee._id),
                status: "Pending",
                subjectEmployee: updated,
                requestedByName: req.user?.name || "",
                extra1: activationExtra1,
                extra2: buildProfileActivationEntityLine(dashboardEmployeeName, updated.employeeId),
                extra3: JSON.stringify({ activationSubject: "employee", activationViewerRole: "hr" }),
            });
            await clearProfileActivationHoldDashboardRows(updated._id);
        } catch (syncErr) {
            console.error("[SubmitApproval] Dashboard Sync Error:", syncErr);
        }

        const employeeName =
            `${employeeBasic.firstName || ""} ${employeeBasic.lastName || ""}`.trim() || "Employee";
        const hrName =
            `${hrEmployee.firstName || ""} ${hrEmployee.lastName || ""}`.trim() || "HR";
        const submitterName =
            req.user?.name ||
            [req.user?.firstName, req.user?.lastName].filter(Boolean).join(" ").trim() ||
            "";
        notifyHrProfileActivationRequestEmail({
            hrEmail,
            hrName,
            employeeName,
            employeeId,
            activationTypeLabel,
            pendingCardsText: pendingCards.length ? pendingCards.join(", ") : "",
            pendingChanges: Array.isArray(employeeBasic.pendingReactivationChanges)
                ? employeeBasic.pendingReactivationChanges
                : [],
            submitterName,
            isAdminSubmitter,
            reason: "Profile submitted for activation review",
            req,
        }).catch((e) => console.error("[SubmitApproval] HR email error:", e));

        const completeEmployee = await getCompleteEmployee(employeeId);
        delete completeEmployee.password;

        return res.status(200).json({
            message: "Profile submitted for approval.",
            employee: completeEmployee
        });
    } catch (error) {
        console.error("Failed to submit profile for approval:", error);
        return res.status(500).json({ message: error.message || "Failed to submit profile for approval." });
    }
};
