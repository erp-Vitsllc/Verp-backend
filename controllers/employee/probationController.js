import EmployeeBasic from "../../models/EmployeeBasic.js";
import { sendProbationWorkflowEmail, ensureProbationRequestForEmployee, ensureProbationDashboardTask } from "../../utils/sendProbationWorkflowEmail.js";

const toObjIdString = (v) => (v == null ? "" : String(v));

const resolveActorEmployee = async (req) => {
    if (req.user?.employeeObjectId) {
        const emp = await EmployeeBasic.findById(req.user.employeeObjectId);
        if (emp) return emp;
    }
    if (req.user?.employeeId) {
        return EmployeeBasic.findOne({ employeeId: req.user.employeeId });
    }
    return null;
};

const isHrFinalApprover = (actor) => {
    const dept = String(actor?.department || "").toLowerCase();
    const role = String(actor?.role || "").toLowerCase();
    return dept.includes("hr") || role.includes("hr") || String(actor?.employeeId || "") === "VEGA-HR-0000";
};

export const requestProbationChange = async (req, res) => {
    try {
        const employee = await EmployeeBasic.findById(req.params.id);
        if (!employee) return res.status(404).json({ message: "Employee not found" });
        const created = await ensureProbationRequestForEmployee(employee);
        return res.status(200).json({
            message: created ? "Probation change request created." : "No probation request needed.",
            request: employee.probationChangeRequest || null,
        });
    } catch (err) {
        return res.status(500).json({ message: err.message || "Failed to create probation request." });
    }
};

export const confirmProbationByHOD = async (req, res) => {
    try {
        const actor = await resolveActorEmployee(req);
        if (!actor) return res.status(401).json({ message: "Unable to resolve acting employee." });

        const employee = await EmployeeBasic.findById(req.params.id);
        if (!employee) return res.status(404).json({ message: "Employee not found" });
        if (!employee.probationChangeRequest || employee.probationChangeRequest.status !== "pending_hod") {
            return res.status(400).json({ message: "No pending HOD confirmation found." });
        }

        employee.probationChangeRequest.status = "pending_employee";
        employee.probationChangeRequest.hodConfirmedAt = new Date();
        employee.probationChangeRequest.hodConfirmedBy = actor._id;
        employee.probationChangeRequest.hrSubmittedAt = new Date();
        employee.probationChangeRequest.hrSubmittedBy = actor._id;
        employee.probationChangeRequest.workflow.push({
            role: "Employee",
            assignedTo: employee._id,
            status: "pending",
            assignedAt: new Date(),
            comment: "Awaiting employee approval for probation status change.",
        });
        await employee.save();

        await sendProbationWorkflowEmail({
            employee,
            phase: "pending_employee_approval",
            probationEndDate: employee.probationChangeRequest.probationEndDate,
            actorName: `${actor.firstName || ""} ${actor.lastName || ""}`.trim() || actor.employeeId,
        });

        return res.status(200).json({ message: "Probation request confirmed and sent to employee approval." });
    } catch (err) {
        return res.status(500).json({ message: err.message || "Failed to confirm probation request." });
    }
};

export const employeeRespondProbationChange = async (req, res) => {
    try {
        const actor = await resolveActorEmployee(req);
        if (!actor) return res.status(401).json({ message: "Unable to resolve acting employee." });

        const { action, reason } = req.body || {};
        if (!["approve", "reject"].includes(String(action || "").toLowerCase())) {
            return res.status(400).json({ message: "Action must be approve or reject." });
        }

        const employee = await EmployeeBasic.findById(req.params.id);
        if (!employee) return res.status(404).json({ message: "Employee not found" });
        if (toObjIdString(actor._id) !== toObjIdString(employee._id)) {
            return res.status(403).json({ message: "Only the employee can respond to this probation request." });
        }
        if (!employee.probationChangeRequest || employee.probationChangeRequest.status !== "pending_employee") {
            return res.status(400).json({ message: "No pending employee probation approval found." });
        }

        const isApprove = String(action).toLowerCase() === "approve";
        employee.probationChangeRequest.status = isApprove ? "pending_hr_final" : "rejected";
        employee.probationChangeRequest.employeeDecisionAt = new Date();
        employee.probationChangeRequest.employeeDecisionBy = employee._id;
        employee.probationChangeRequest.rejectionReason = isApprove ? "" : String(reason || "");
        employee.probationChangeRequest.workflow.push({
            role: "Employee",
            assignedTo: employee._id,
            status: isApprove ? "approved" : "rejected",
            assignedAt: new Date(),
            actionedAt: new Date(),
            comment: isApprove ? "Employee approved probation status change." : (reason || "Employee rejected."),
        });

        if (isApprove) {
            employee.probationChangeRequest.workflow.push({
                role: "HR",
                assignedTo: null,
                status: "pending",
                assignedAt: new Date(),
                comment: "Awaiting HR final approval to change status to Permanent.",
            });
        }
        await employee.save();

        if (isApprove) {
            await sendProbationWorkflowEmail({
                employee,
                phase: "employee_approved",
                probationEndDate: employee.probationChangeRequest.probationEndDate,
                actorName: `${employee.firstName || ""} ${employee.lastName || ""}`.trim() || employee.employeeId,
            });
        }

        return res.status(200).json({
            message: isApprove
                ? "Probation change approved by employee and sent for HR final approval."
                : "Probation change rejected by employee.",
            employee,
        });
    } catch (err) {
        return res.status(500).json({ message: err.message || "Failed to process employee probation response." });
    }
};

export const finalizeProbationByHR = async (req, res) => {
    try {
        const actor = await resolveActorEmployee(req);
        if (!actor) return res.status(401).json({ message: "Unable to resolve acting employee." });
        if (!isHrFinalApprover(actor)) {
            return res.status(403).json({ message: "Only HR can finalize probation approval." });
        }

        const { action, reason } = req.body || {};
        if (!["approve", "reject"].includes(String(action || "").toLowerCase())) {
            return res.status(400).json({ message: "Action must be approve or reject." });
        }

        const employee = await EmployeeBasic.findById(req.params.id);
        if (!employee) return res.status(404).json({ message: "Employee not found" });
        if (!employee.probationChangeRequest || employee.probationChangeRequest.status !== "pending_hr_final") {
            return res.status(400).json({ message: "No pending HR final probation approval found." });
        }

        const isApprove = String(action).toLowerCase() === "approve";
        employee.probationChangeRequest.status = isApprove ? "approved" : "rejected";
        employee.probationChangeRequest.workflow.push({
            role: "HR",
            assignedTo: actor._id,
            status: isApprove ? "approved" : "rejected",
            assignedAt: new Date(),
            actionedAt: new Date(),
            comment: isApprove
                ? "HR finalized probation and approved Permanent status."
                : (reason || "HR rejected final probation approval."),
        });

        if (isApprove) {
            employee.status = "Permanent";
            employee.probationPeriod = null;
            employee.profileStatus = "inactive";
            employee.profileApprovalStatus = "draft";
        } else {
            employee.probationChangeRequest.rejectionReason = String(reason || "HR rejected final probation approval.");
        }

        await employee.save();

        if (isApprove) {
            await ensureProbationDashboardTask({
                assignedTo: employee._id,
                assignedToEmpId: employee.employeeId,
                requestId: employee._id,
                subjectEmployeeId: employee.employeeId,
                subjectName: `${employee.firstName || ""} ${employee.lastName || ""}`.trim() || employee.employeeId,
                extra1: "Probation status changed to Permanent",
                extra2: "Open Work Details tab to review updated status",
            });
        }

        await sendProbationWorkflowEmail({
            employee,
            phase: "hr_finalized",
            probationEndDate: employee.probationChangeRequest.probationEndDate,
            actorName: `${actor.firstName || ""} ${actor.lastName || ""}`.trim() || actor.employeeId,
        });

        return res.status(200).json({
            message: isApprove
                ? "HR approved probation request and employee status moved to Permanent."
                : "HR rejected final probation approval.",
            employee,
        });
    } catch (err) {
        return res.status(500).json({ message: err.message || "Failed to finalize probation request." });
    }
};

