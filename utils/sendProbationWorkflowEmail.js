import nodemailer from "nodemailer";
import { resolveFrontendBaseUrl, emailFrontendUrl } from './resolveFrontendBaseUrl.js';
import { getDepartmentHOD } from "./getDepartmentHOD.js";
import DashboardAction from "../models/DashboardAction.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import { resolveEmployeeEmail, addEmployeeEmailToSet } from "./resolveEmployeeEmail.js";
import { isEmployeeActiveForNotifications } from "./applyEmployeeLeftUserStatus.js";

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

const getStakeholders = async (employee) => {
    let employeeHod = null;
    if (employee?.primaryReportee) {
        employeeHod = await EmployeeBasic.findById(employee.primaryReportee)
            .select("employeeId firstName lastName companyEmail workEmail personalEmail email")
            .lean();
    }

    const [hr, admin] = await Promise.all([
        getDepartmentHOD("hr"),
        getDepartmentHOD("admincontroller"),
    ]);
    const map = new Map();
    [hr, admin, employeeHod].forEach((emp) => {
        if (!emp) return;
        const key = (emp._id?.toString?.() || emp.employeeId || "").toString();
        if (!key) return;
        map.set(key, emp);
    });
    return Array.from(map.values());
};

const startOfDay = (d) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
};

export const ensureProbationDashboardTask = async ({
    assignedTo,
    assignedToEmpId,
    requestId,
    subjectEmployeeId,
    subjectName,
    extra1,
    extra2,
}) => {
    if (!assignedTo || !requestId || !extra1) return;
    const exists = await DashboardAction.findOne({
        assignedTo,
        requestId,
        requestType: "Probation Change",
        status: "Pending",
        extra1,
    }).lean();
    if (exists) return;
    await DashboardAction.create({
        assignedTo,
        ...(assignedToEmpId ? { assignedToEmpId } : {}),
        requestId,
        requestType: "Probation Change",
        status: "Pending",
        subjectEmployeeId,
        subjectName,
        requestedByName: "System",
        extra1,
        extra2,
    });
};

export const sendProbationWorkflowEmail = async ({
    employee,
    phase,
    probationEndDate,
    actorName = "System",
}) => {
    try {
        const transporter = createTransporter();
        if (!transporter || !employee || !isEmployeeActiveForNotifications(employee)) return;

        const stakeholders = await getStakeholders(employee);
        const stakeholderEmails = stakeholders
            .map((s) => resolveEmployeeEmail(s).email)
            .filter(Boolean);
        const employeeEmail = resolveEmployeeEmail(employee).email;

        const employeeName = `${employee.firstName || ""} ${employee.lastName || ""}`.trim();
        const probText = probationEndDate
            ? new Date(probationEndDate).toLocaleDateString()
            : "N/A";
        const baseUrl = resolveFrontendBaseUrl();
        const profileUrl = `${baseUrl}/emp/${employee.employeeId}`;
        const workDetailsUrl = `${baseUrl}/emp/${employee.employeeId}?tab=work-details`;

        if (phase === "request_created") {
            if (!stakeholderEmails.length) return;
            await transporter.sendMail({
                fromName: "VeRP Portal",
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
                fromName: "VeRP Portal",
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
                fromName: actorName,
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
                fromName: actorName,
                to: recipients,
                subject: `${isApproved ? "Probation Finalized" : "Probation Final Decision"}: ${employeeName}`,
                html: `
                    <p>Hello,</p>
                    <p>HR has finalized probation workflow for <strong>${employeeName}</strong> (${employee.employeeId}).</p>
                    <p>Final outcome: <strong>${isApproved ? "Approved - Status changed to Permanent" : "Rejected / Not approved"}</strong>.</p>
                    <p>Actioned by: <strong>${actorName}</strong></p>
                    <p>${isApproved ? `Status has been updated from <strong>Probation</strong> to <strong>Permanent</strong>.` : ""}</p>
                    <p><a href="${workDetailsUrl}">Open Work Details Tab</a></p>
                `,
            });
        }
    } catch (err) {
        console.error("[ProbationWorkflowEmail] Failed:", err);
    }
};

export const ensureProbationRequestForEmployee = async (employeeDoc) => {
    if (!employeeDoc || !isEmployeeActiveForNotifications(employeeDoc)) return false;
    if (employeeDoc.status !== "Probation") return false;

    const EmployeeVisa = (await import("../models/EmployeeVisa.js")).default;
    const visa = await EmployeeVisa.findOne({ employeeId: employeeDoc.employeeId })
        .select("employment")
        .lean();
    const { resolveProbationStartDate } = await import("./probationStartDate.js");
    const startDate = resolveProbationStartDate(employeeDoc.toObject?.() || employeeDoc, visa);
    if (!startDate) return false;

    const today = startOfDay(new Date());
    const joinDate = new Date(startDate);
    const probationMonths = employeeDoc.probationPeriod || 6;
    const probationEndDate = new Date(joinDate);
    probationEndDate.setMonth(probationEndDate.getMonth() + probationMonths);
    probationEndDate.setHours(0, 0, 0, 0);

    if (today.getTime() !== probationEndDate.getTime()) return false;

    const current = employeeDoc.probationChangeRequest || {};
    const alreadyOpen = ["pending_hod", "pending_employee", "pending_hr_final"].includes(current.status);
    const alreadyFinal = ["approved", "rejected"].includes(current.status);
    if (alreadyOpen || alreadyFinal) return false;

    const stakeholders = await getStakeholders(employeeDoc);
    await employeeDoc.populate("primaryReportee", "firstName lastName employeeId companyEmail workEmail personalEmail email");
    const primaryReportee = employeeDoc.primaryReportee;
    const primaryReporteeEmail = resolveEmployeeEmail(primaryReportee || {}).email;
    const primaryReporteeName = `${primaryReportee?.firstName || ""} ${primaryReportee?.lastName || ""}`.trim() || primaryReportee?.employeeId || "Primary reportee";
    const baseUrl = resolveFrontendBaseUrl();
    const workDetailsUrl = `${baseUrl}/emp/${employeeDoc.employeeId}?tab=work-details`;
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
    if (primaryReportee?._id) {
        await ensureProbationDashboardTask({
            assignedTo: primaryReportee._id,
            assignedToEmpId: primaryReportee.employeeId,
            requestId: employeeDoc._id,
            subjectEmployeeId: employeeDoc.employeeId,
            subjectName: `${employeeDoc.firstName || ""} ${employeeDoc.lastName || ""}`.trim() || employeeDoc.employeeId,
            extra1: "Probation completed today - confirm status change request",
            extra2: `Review ${employeeDoc.employeeId} in Work Details`,
        });
    }
    if (primaryReporteeEmail) {
        const transporter = createTransporter();
        if (transporter) {
            await transporter.sendMail({
                fromName: "VeRP Portal",
                to: primaryReporteeEmail,
                subject: `Probation completion requires your review: ${employeeDoc.firstName || ""} ${employeeDoc.lastName || ""}`.trim(),
                html: `
                    <p>Hello ${primaryReporteeName},</p>
                    <p>Probation duration has completed today for <strong>${employeeDoc.firstName || ""} ${employeeDoc.lastName || ""}</strong> (${employeeDoc.employeeId}).</p>
                    <p>Please review and proceed with probation-to-permanent workflow.</p>
                    <p><a href="${workDetailsUrl}">Open Employee Work Details</a></p>
                `,
            });
        }
    }
    await sendProbationWorkflowEmail({
        employee: employeeDoc,
        phase: "request_created",
        probationEndDate,
    });
    return true;
};

