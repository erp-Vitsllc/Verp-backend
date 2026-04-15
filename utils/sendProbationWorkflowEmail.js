import nodemailer from "nodemailer";
import { getDepartmentHOD } from "./getDepartmentHOD.js";
import { getManagementHOD } from "./getManagementHOD.js";

const resolveEmployeeEmail = (emp) =>
    emp?.companyEmail || emp?.workEmail || emp?.personalEmail || emp?.email || null;

const createTransporter = () => {
    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!emailUser || !emailPass) return null;
    return nodemailer.createTransport({
        host: "smtp.office365.com",
        port: 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass },
    });
};

const getStakeholders = async () => {
    const [hr, admin, hod] = await Promise.all([
        getDepartmentHOD("hr"),
        getDepartmentHOD("admincontroller"),
        getManagementHOD(),
    ]);
    const map = new Map();
    [hr, admin, hod].forEach((emp) => {
        if (!emp) return;
        const key = (emp._id?.toString?.() || emp.employeeId || "").toString();
        if (!key) return;
        map.set(key, emp);
    });
    return Array.from(map.values());
};

export const sendProbationWorkflowEmail = async ({
    employee,
    phase,
    probationEndDate,
    actorName = "System",
}) => {
    try {
        const transporter = createTransporter();
        if (!transporter || !employee) return;

        const stakeholders = await getStakeholders();
        const stakeholderEmails = stakeholders.map(resolveEmployeeEmail).filter(Boolean);
        const employeeEmail = resolveEmployeeEmail(employee);

        const employeeName = `${employee.firstName || ""} ${employee.lastName || ""}`.trim();
        const probText = probationEndDate
            ? new Date(probationEndDate).toLocaleDateString()
            : "N/A";
        const profileUrl = `${process.env.FRONTEND_URL || "http://localhost:3000"}/emp/${employee.employeeId}`;

        if (phase === "request_created") {
            if (!stakeholderEmails.length) return;
            await transporter.sendMail({
                from: `"VeRP Portal" <${process.env.EMAIL_USER}>`,
                to: [...new Set(stakeholderEmails)],
                subject: `Probation Change Request: ${employeeName}`,
                html: `
                    <p>Hello,</p>
                    <p>Probation period has completed for <strong>${employeeName}</strong> (${employee.employeeId}).</p>
                    <p>Probation end date: <strong>${probText}</strong></p>
                    <p>Please review and process probation change workflow.</p>
                    <p><a href="${profileUrl}">Open Employee Profile</a></p>
                `,
            });
            return;
        }

        if (phase === "pending_employee_approval") {
            const recipients = [...new Set([employeeEmail, ...stakeholderEmails].filter(Boolean))];
            if (!recipients.length) return;
            await transporter.sendMail({
                from: `"VeRP Portal" <${process.env.EMAIL_USER}>`,
                to: recipients,
                subject: `Probation Update Requires Employee Approval: ${employeeName}`,
                html: `
                    <p>Hello,</p>
                    <p>HR has initiated probation-to-permanent update for <strong>${employeeName}</strong> (${employee.employeeId}).</p>
                    <p>The request is now waiting for employee approval.</p>
                    <p><a href="${profileUrl}">Open Employee Profile</a></p>
                `,
            });
            return;
        }

        if (phase === "employee_approved") {
            if (!stakeholderEmails.length) return;
            await transporter.sendMail({
                from: `"VeRP Portal" <${process.env.EMAIL_USER}>`,
                to: [...new Set(stakeholderEmails)],
                subject: `Probation Approved by Employee: ${employeeName}`,
                html: `
                    <p>Hello,</p>
                    <p>Employee <strong>${employeeName}</strong> (${employee.employeeId}) approved probation status change.</p>
                    <p>Request is now pending <strong>HR final approval</strong> to set status as <strong>Permanent</strong>.</p>
                    <p>Actioned by: <strong>${actorName}</strong></p>
                    <p><a href="${profileUrl}">Open Employee Profile</a></p>
                `,
            });
            return;
        }

        if (phase === "hr_finalized") {
            const recipients = [...new Set([employeeEmail, ...stakeholderEmails].filter(Boolean))];
            if (!recipients.length) return;
            const isApproved = employee?.status === "Permanent";
            await transporter.sendMail({
                from: `"VeRP Portal" <${process.env.EMAIL_USER}>`,
                to: recipients,
                subject: `${isApproved ? "Probation Finalized" : "Probation Final Decision"}: ${employeeName}`,
                html: `
                    <p>Hello,</p>
                    <p>HR has finalized probation workflow for <strong>${employeeName}</strong> (${employee.employeeId}).</p>
                    <p>Final outcome: <strong>${isApproved ? "Approved - Status changed to Permanent" : "Rejected / Not approved"}</strong>.</p>
                    <p>Actioned by: <strong>${actorName}</strong></p>
                    <p><a href="${profileUrl}">Open Employee Profile</a></p>
                `,
            });
        }
    } catch (err) {
        console.error("[ProbationWorkflowEmail] Failed:", err);
    }
};

export const ensureProbationRequestForEmployee = async (employeeDoc) => {
    if (!employeeDoc || employeeDoc.status !== "Probation" || !employeeDoc.dateOfJoining) return false;
    const today = new Date();
    const joinDate = new Date(employeeDoc.contractJoiningDate || employeeDoc.dateOfJoining);
    const probationMonths = employeeDoc.probationPeriod || 6;
    const probationEndDate = new Date(joinDate);
    probationEndDate.setMonth(probationEndDate.getMonth() + probationMonths);
    probationEndDate.setHours(0, 0, 0, 0);

    if (today < probationEndDate) return false;

    const current = employeeDoc.probationChangeRequest || {};
    const alreadyOpen = ["pending_hod", "pending_employee", "pending_hr_final"].includes(current.status);
    const alreadyFinal = ["approved", "rejected"].includes(current.status);
    if (alreadyOpen || alreadyFinal) return false;

    const stakeholders = await getStakeholders();
    employeeDoc.probationChangeRequest = {
        status: "pending_hod",
        probationEndDate,
        requestedAt: new Date(),
        workflow: stakeholders.map((s) => ({
            role:
                s?.department?.toLowerCase?.().includes("hr")
                    ? "HR"
                    : s?.designation?.toLowerCase?.().includes("admin")
                      ? "Admin"
                      : "HOD",
            assignedTo: s?._id || null,
            status: "notified",
            assignedAt: new Date(),
        })),
    };
    await employeeDoc.save();
    await sendProbationWorkflowEmail({
        employee: employeeDoc,
        phase: "request_created",
        probationEndDate,
    });
    return true;
};

