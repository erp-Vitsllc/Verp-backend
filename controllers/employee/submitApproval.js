import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getCompleteEmployee } from "../../services/employeeService.js";
import { resolveFlowchartHrEmployee } from "../../utils/resolveFlowchartHrEmployee.js";
import { resolveProfileActivationSubmitterId } from "../../utils/resolveProfileActivationSubmitterId.js";

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
        const employeeId = employeeBasic.employeeId;
        const wasPreviouslyActive = Array.isArray(employeeBasic.profileWorkflow)
            ? employeeBasic.profileWorkflow.some((w) => String(w?.status || "").toLowerCase() === "active")
            : false;
        const activationTypeLabel = wasPreviouslyActive ? "Reactivation" : "New Activation";
        const pendingCards = Array.isArray(employeeBasic.pendingReactivationChanges)
            ? [...new Set(employeeBasic.pendingReactivationChanges.map((x) => String(x?.card || "").trim()).filter(Boolean))]
            : [];
        const pendingCardsText = pendingCards.length ? ` | Requested Changes: ${pendingCards.join(", ")}` : "";

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
            await syncDashboardAction({
                requestId: updated._id,
                requestType: "Profile Activation",
                assignedTo: String(hrEmployee._id),
                status: "Pending",
                subjectEmployee: updated,
                requestedByName: req.user?.name || "",
                extra1: `${activationTypeLabel} — HR review${pendingCardsText}`,
                extra2: updated.designation || ""
            });
        } catch (syncErr) {
            console.error("[SubmitApproval] Dashboard Sync Error:", syncErr);
        }

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
