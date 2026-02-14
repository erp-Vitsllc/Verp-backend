import nodemailer from "nodemailer";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getCompleteEmployee } from "../../services/employeeService.js";
import mongoose from "mongoose";

// Helper to send email
const sendEmail = async (to, subject, html) => {
    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();

    if (!emailUser || !emailPass) {
        throw new Error("Email credentials are not configured.");
    }

    const transporter = nodemailer.createTransport({
        host: "smtp.office365.com",
        port: 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass }
    });

    await transporter.sendMail({
        from: `"VeRP Portal" <${emailUser}>`,
        to,
        subject,
        html
    });
};

export const requestNotice = async (req, res) => {
    const { id } = req.params;
    const { duration, reason, attachment } = req.body;

    try {
        console.log("DEBUG: requestNotice called with ID:", id);
        let employee;
        if (mongoose.Types.ObjectId.isValid(id) && id.toString().length === 24) {
            console.log("DEBUG: Checking findById...");
            employee = await EmployeeBasic.findById(id);
        }

        if (!employee) {
            console.log("DEBUG: Checking findOne by employeeId...");
            employee = await EmployeeBasic.findOne({ employeeId: id });
        }

        if (!employee) return res.status(404).json({ message: "Employee not found" });

        // Pre-fetch reportee for Snapshot Logic
        // We can use getCompleteEmployee here or populate
        const fullEmployeeInit = await getCompleteEmployee(employee._id);
        const reporteeInit = fullEmployeeInit?.primaryReportee;

        // Save request
        employee.noticeRequest = {
            duration,
            reason,
            attachment,
            status: "Pending",
            originalStatus: employee.status,
            requestedAt: new Date(),
            // SNAPSHOT: Manager who received the request
            submittedTo: reporteeInit ? reporteeInit._id : null,
            // WORKFLOW: Initial Pending Step
            workflow: reporteeInit ? [{
                role: 'Manager',
                assignedTo: reporteeInit._id,
                status: 'Pending',
                assignedAt: new Date()
            }] : []
        };
        await employee.save();

        // === SYNC DASHBOARD ACTION ===
        try {
            const { syncDashboardAction } = await import("../../utils/syncDashboard.js");
            if (reporteeInit) {
                await syncDashboardAction({
                    requestId: employee._id,
                    requestType: 'Notice Request',
                    assignedTo: reporteeInit._id,
                    status: 'Pending',
                    subjectEmployee: employee,
                    extra1: reason,
                    extra2: duration
                });
            }
        } catch (syncErr) {
            console.error("[RequestNotice] Dashboard Sync Error:", syncErr);
        }

        // Send email to Primary Reportee
        // We need populated reportee data
        const fullEmployee = await getCompleteEmployee(id);
        const reportee = fullEmployee?.primaryReportee;

        if (reportee) {
            const reporteeEmail = reportee.companyEmail || reportee.workEmail || reportee.email;

            if (reporteeEmail) {
                const reporteeName = `${reportee.firstName || ""} ${reportee.lastName || ""}`.trim();
                const employeeName = `${employee.firstName || ""} ${employee.lastName || ""}`.trim();
                const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
                const baseUrl = process.env.FRONTEND_URL || origin || "http://localhost:3000";
                const profileUrl = `${baseUrl}/emp/${employee.employeeId}?action=review_notice`;

                const html = `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 10px; overflow: hidden;">
                        <div style="background-color: #000000; color: white; padding: 20px; text-align: center;">
                            <h2 style="margin: 0;">Notice Request</h2>
                        </div>
                        <div style="padding: 30px;">
                            <p>Hello <strong>${reporteeName}</strong>,</p>
                            <p>Greetings from VeRP Portal.</p>
                            <p>The employee below has submitted a request to initiate their notice period. Kindly review and take appropriate action by approving or rejecting the request.</p>
                            
                            <div style="background-color: #fff7ed; padding: 20px; border-radius: 8px; border: 1px solid #ffedd5; margin: 25px 0;">
                                <p><strong>Employee Name:</strong> ${employeeName}</p>
                                <p><strong>Employee ID:</strong> ${employee.employeeId}</p>
                                <p><strong>Department:</strong> ${employee.department || 'N/A'}</p>
                                <p><strong>Designation:</strong> ${employee.designation || 'N/A'}</p>
                                <p><strong>Reason:</strong> ${reason}</p>
                                <p><strong>Duration:</strong> ${duration}</p>
                            </div>
                            
                            <p style="text-align: center; margin: 35px 0;">
                                <a href="${profileUrl}" style="background-color: #f59e0b; color: white; padding: 14px 30px; text-decoration: none; border-radius: 6px; font-weight: bold;">Review Request</a>
                            </p>
                            <p>Thank you for your time and attention to this matter.</p>
                            <p>Best regards,</p>
                            <p>The VeRP Portal Team</p>
                        </div>
                    </div>
                `;

                console.log(`[Email Debug] Sending Notice Request to: ${reporteeEmail}`);
                await sendEmail(reporteeEmail, `Notice Request: ${employeeName}`, html);
            }
        }

        res.status(200).json({ message: "Notice request submitted successfully." });
    } catch (error) {
        console.error("Error asking for notice:", error);
        res.status(500).json({ message: error.message });
    }
};

export const updateNoticeStatus = async (req, res) => {
    const { id } = req.params;
    const { status, actionedBy, rejectionReason } = req.body; // status: "Approved" | "Rejected"
    if (status === 'Rejected' && (!rejectionReason || rejectionReason.trim().length === 0)) {
        return res.status(400).json({ message: "Reason for rejection is mandatory." });
    }

    try {
        let employee;
        if (mongoose.Types.ObjectId.isValid(id) && id.toString().length === 24) {
            employee = await EmployeeBasic.findById(id);
        }

        if (!employee) {
            employee = await EmployeeBasic.findOne({ employeeId: id });
        }

        if (!employee) return res.status(404).json({ message: "Employee not found" });

        if (!employee.noticeRequest) {
            return res.status(400).json({ message: "No active notice request found." });
        }

        employee.noticeRequest.status = status;
        employee.noticeRequest.actionedAt = new Date();

        // WORKFLOW: Update Pending Step
        if (employee.noticeRequest.workflow) {
            const pendingStep = employee.noticeRequest.workflow.find(w => w.status === 'Pending');
            if (pendingStep) {
                pendingStep.status = status;
                pendingStep.actionedAt = new Date();
                if (status === 'Rejected') pendingStep.comment = rejectionReason;
            } else {
                // Fallback if missing
                employee.noticeRequest.workflow.push({
                    role: 'Manager',
                    assignedTo: actionedBy || employee.primaryReportee, // Best effort
                    status: status,
                    assignedAt: new Date(),
                    actionedAt: new Date(),
                    comment: status === 'Rejected' ? rejectionReason : undefined
                });
            }
        }

        // Resolve actionedBy to a valid EmployeeBasic ObjectId
        let resolvedApproverId = actionedBy;

        // 1. Try to resolve from authenticated user (most reliable)
        if (req.user) {
            const approver = await EmployeeBasic.findOne({
                $or: [
                    { employeeId: req.user.employeeId },
                    { email: req.user.email },
                    { companyEmail: req.user.email } // Handle case where email is in companyEmail
                ]
            });
            if (approver) {
                resolvedApproverId = approver._id;
            }
        }

        // 2. If no req.user, or failed (e.g. testing), trust valid actionedBy if it's an EmployeeBasic
        if (!resolvedApproverId && actionedBy && mongoose.Types.ObjectId.isValid(actionedBy)) {
            // Optional: verify it exists if needed, but for now trust if valid structure
            resolvedApproverId = actionedBy;
        }

        if (resolvedApproverId) {
            employee.noticeRequest.actionedBy = resolvedApproverId;
        }

        if (status === "Approved") {
            employee.status = "Notice";
        }

        await employee.save();

        // === SYNC DASHBOARD ACTION ===
        try {
            const { syncDashboardAction } = await import("../../utils/syncDashboard.js");
            await syncDashboardAction({
                requestId: employee._id,
                requestType: 'Notice Request',
                status: status, // Approved or Rejected
                subjectEmployee: employee,
                actionedBy: resolvedApproverId,
                comment: status === 'Rejected' ? rejectionReason : undefined
            });
        } catch (syncErr) {
            console.error("[UpdateNoticeStatus] Dashboard Sync Error:", syncErr);
        }

        // Get Approver Name (Actioned By or Primary Reportee)
        let approverName = "Your Supervisor";

        // 1. Try the user who performed the action
        if (actionedBy && mongoose.Types.ObjectId.isValid(actionedBy)) {
            const approver = await EmployeeBasic.findById(actionedBy);
            if (approver) {
                approverName = `${approver.firstName || ""} ${approver.lastName || ""}`.trim();
            }
        }
        // 2. Fallback to the assigned Primary Reportee if actionedBy is missing
        else if (employee.primaryReportee && mongoose.Types.ObjectId.isValid(employee.primaryReportee)) {
            const reportee = await EmployeeBasic.findById(employee.primaryReportee);
            if (reportee) {
                approverName = `${reportee.firstName || ""} ${reportee.lastName || ""}`.trim();
            }
        }

        // Notify Recipients (Employee + Previous Approvers)
        const employeeEmail = employee.companyEmail || employee.workEmail || employee.email;
        let recipients = employeeEmail ? [employeeEmail] : [];

        if (status === 'Rejected' && employee.noticeRequest?.workflow?.length > 0) {
            const previousApproverIds = employee.noticeRequest.workflow
                .filter(w => w.status === 'Approved' && w.assignedTo)
                .map(w => w.assignedTo);

            if (previousApproverIds.length > 0) {
                const approvers = await EmployeeBasic.find({ _id: { $in: previousApproverIds } }).select('companyEmail workEmail email');
                const approverEmails = approvers.map(a => a.companyEmail || a.workEmail || a.email).filter(e => e);
                recipients = [...new Set([...recipients, ...approverEmails])];
            }
        }

        if (recipients.length > 0) {
            const employeeName = `${employee.firstName || ""} ${employee.lastName || ""}`.trim();
            const subject = `Notice Period ${status}`;
            const color = status === 'Approved' ? '#10b981' : '#ef4444'; // Green or Red

            const html = `
               <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 10px; overflow: hidden;">
    <div style="background-color: #000000; color: white; padding: 20px; text-align: center;">
        <h2 style="margin: 0;">Notice Period ${status}</h2>
    </div>
    <div style="padding: 30px;">
        <p>Hello <strong>${employeeName}</strong>,</p>
        <p>Greetings from the VeRP Portal.</p>
        
        ${status === 'Approved' ? `
        <p>This is to inform you that your employment status has been changed to <strong>Notice Period</strong> by your primary reporting manager.</p>
        <p>As per this update, your <strong>${employee.noticeRequest.duration || 'notice period'}</strong> notice period has now commenced.</p>
        ` : `
        <p>
            This is to inform you that your Notice Period has been 
            <strong>${status}</strong> by <strong>${approverName}</strong>.
        </p>
        <p><strong>Reason for Rejection:</strong> ${rejectionReason}</p>
        `}
        
        <p>Thank you for your attention to this matter.</p>
        <p>Best regards,</p>
        <p><strong>The VeRP Portal Team</strong></p>
    </div>
</div>

            `;
            await sendEmail(recipients, subject, html);
        }

        res.status(200).json({ message: `Request ${status} successfully.` });
    } catch (error) {
        console.error("Error updating notice status:", error);
        res.status(500).json({ message: error.message });
    }
};
