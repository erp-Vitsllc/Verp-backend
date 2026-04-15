import nodemailer from "nodemailer";
import Company from "../models/Company.js";
import { resolveFlowchartHrEmployee } from "./resolveFlowchartHrEmployee.js";
import { syncDashboardAction } from "./syncDashboard.js";

const hasValue = (v) => !(v === undefined || v === null || (typeof v === "string" && v.trim() === ""));
const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};

const hasAttachment = (v) => hasValue(v);

const hasMoaDocument = (company = {}) => {
    const docs = Array.isArray(company.documents) ? company.documents : [];
    return docs.some((d) => {
        const t = String(d?.type || "").toLowerCase();
        const looksLikeMoa = t.includes("moa");
        const docUrl = d?.document?.url;
        return looksLikeMoa && hasValue(docUrl);
    });
};

export const calculateCompanyActivationProgress = (company = {}) => {
    const owners = Array.isArray(company.owners) ? company.owners : [];
    const validOwners = owners.filter((o) => hasValue(o?.name) && num(o?.sharePercentage) > 0);
    const totalShare = validOwners.reduce((sum, o) => sum + num(o.sharePercentage), 0);

    const checks = [
        {
            key: "basicDetails",
            label: "All basic details",
            completed: [
                company.name,
                company.nickName,
                company.companyId,
                company.email,
                company.phone,
                company.establishedDate,
            ].every(hasValue),
        },
        {
            key: "tradeLicense",
            label: "Trade license",
            completed: [
                company.tradeLicenseNumber,
                company.tradeLicenseIssueDate,
                company.tradeLicenseExpiry,
            ].every(hasValue) && hasAttachment(company.tradeLicenseAttachment),
        },
        {
            key: "establishmentCard",
            label: "Establishment card",
            completed: [
                company.establishmentCardNumber,
                company.establishmentCardExpiry,
            ].every(hasValue) && hasAttachment(company.establishmentCardAttachment),
        },
        {
            key: "ownerDetails",
            label: "Owner details",
            completed: validOwners.length >= 1 && Math.abs(totalShare - 100) < 0.001,
        },
        {
            key: "moa",
            label: "MOA",
            completed: hasMoaDocument(company),
        },
    ];

    const completed = checks.filter((c) => c.completed).length;
    const total = checks.length;
    const percentage = Math.round((completed / total) * 100);
    const missing = checks.filter((c) => !c.completed).map((c) => c.label);

    return { checks, completed, total, percentage, missing };
};

const sendCompanyActivationEmailToHr = async ({ company, hrEmail, hrName, requestedByName, reason }) => {
    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!emailUser || !emailPass || !hrEmail) return;

    const transporter = nodemailer.createTransport({
        host: "smtp.office365.com",
        port: 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass },
    });

    const baseUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const companyUrl = `${baseUrl}/Company/${company._id}`;
    const subject = `Company activation request: ${company.name}`;

    const html = `
        <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6; max-width: 640px; margin: 0 auto; border: 1px solid #eee; border-radius: 10px; overflow: hidden;">
            <div style="background:#1d4ed8;color:#fff;padding:18px 22px;">
                <h2 style="margin:0;">Company Activation Request</h2>
            </div>
            <div style="padding:22px;">
                <p>Hello <strong>${hrName}</strong>,</p>
                <p>A company has been submitted for activation / reactivation and requires HR authorization.</p>
                <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;margin:16px 0;">
                    <p style="margin:0;"><strong>Company:</strong> ${company.name || "N/A"}</p>
                    <p style="margin:6px 0 0;"><strong>Company ID:</strong> ${company.companyId || "N/A"}</p>
                    <p style="margin:6px 0 0;"><strong>Requested by:</strong> ${requestedByName || "System"}</p>
                    <p style="margin:6px 0 0;"><strong>Reason:</strong> ${reason || "Activation request"}</p>
                </div>
                <p style="margin-top:20px;">
                    <a href="${companyUrl}" style="background:#2563eb;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:600;display:inline-block;">Review Company</a>
                </p>
            </div>
        </div>
    `;

    await transporter.sendMail({
        from: `"VeRP Portal" <${emailUser}>`,
        to: hrEmail,
        subject,
        html,
    });
};

const getActorName = (actor = {}) => {
    if (actor?.name) return String(actor.name).trim();
    const full = `${actor?.firstName || ""} ${actor?.lastName || ""}`.trim();
    return full || actor?.employeeId || "System";
};

export const submitCompanyActivation = async ({
    companyId,
    actor = null,
    reason = "Company submitted for activation",
    force = false,
}) => {
    const company = await Company.findById(companyId);
    if (!company) return { ok: false, message: "Company not found" };

    const progress = calculateCompanyActivationProgress(company.toObject());
    if (!force && progress.percentage < 100) {
        return {
            ok: false,
            blocked: true,
            message: "Company profile is not 100% complete for activation.",
            progress,
        };
    }

    const hrResolved = await resolveFlowchartHrEmployee();
    if (hrResolved.error) {
        return { ok: false, message: hrResolved.message, code: hrResolved.error };
    }

    const hr = hrResolved.employee;
    const requestedByName = getActorName(actor);

    company.status = "Inactive";
    company.activationStatus = "submitted";
    company.activationSubmittedTo = hr._id;
    if (!Array.isArray(company.activationWorkflow)) company.activationWorkflow = [];
    company.activationWorkflow.push({
        role: "HR",
        assignedTo: hr._id,
        status: "submitted",
        assignedAt: new Date(),
        comment: reason,
    });
    await company.save();

    await syncDashboardAction({
        requestId: company._id,
        requestType: "Company Activation",
        assignedTo: String(hr._id),
        status: "Pending",
        subjectEmployee: {
            employeeId: company.companyId,
            firstName: company.name,
            lastName: "",
            designation: company.nickName || "",
        },
        requestedByName,
        extra1: reason,
        extra2: company.companyId || "",
    });

    try {
        const hrName = `${hr.firstName || ""} ${hr.lastName || ""}`.trim() || "HR";
        await sendCompanyActivationEmailToHr({
            company,
            hrEmail: hrResolved.email,
            hrName,
            requestedByName,
            reason,
        });
    } catch (e) {
        console.error("[submitCompanyActivation] Email failed:", e?.message || e);
    }

    return { ok: true, progress };
};

export const shouldTriggerCompanyReactivation = (beforeCompany = {}, updateData = {}) => {
    if (String(beforeCompany?.status || "").toLowerCase() !== "active") return false;

    // Critical sections that require reactivation when changed after activation
    const hasTradeLicenseChange = [
        "tradeLicenseNumber",
        "tradeLicenseIssueDate",
        "tradeLicenseExpiry",
        "tradeLicenseAttachment",
    ].some((k) => Object.prototype.hasOwnProperty.call(updateData, k));

    const hasEstablishmentCardChange = [
        "establishmentCardNumber",
        "establishmentCardIssueDate",
        "establishmentCardExpiry",
        "establishmentCardAttachment",
    ].some((k) => Object.prototype.hasOwnProperty.call(updateData, k));

    const hasOwnerChange = Object.prototype.hasOwnProperty.call(updateData, "owners");

    const hasMoaChange = Array.isArray(updateData.documents) && updateData.documents.some((d) => {
        const t = String(d?.type || "").toLowerCase();
        return t.includes("moa");
    });

    return hasTradeLicenseChange || hasEstablishmentCardChange || hasOwnerChange || hasMoaChange;
};
