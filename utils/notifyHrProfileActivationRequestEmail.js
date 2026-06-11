import nodemailer from "nodemailer";
import { resolveFrontendBaseUrl, resolveFrontendHostLabel } from "./resolveFrontendBaseUrl.js";
import {
    buildEmployeeActivationHrEmailHtml,
    buildEmployeeActivationHrEmailSubject,
} from "./buildEmployeeActivationHrEmail.js";

/**
 * HR inbox email when a profile is queued for activation (submit-approval API or lightweight notify).
 */
export async function notifyHrProfileActivationRequestEmail({
    hrEmail,
    hrName = "HR",
    employeeName = "Employee",
    employeeId = "",
    activationTypeLabel = "Activation",
    pendingCardsText = "",
    pendingChanges = [],
    submitterName = "",
    isAdminSubmitter = false,
    adminDirectApplied = false,
    reason = "",
    description = "",
    req = null,
}) {
    const to = (hrEmail || "").trim();
    if (!to) return;

    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!emailUser || !emailPass) {
        console.warn("[notifyHrProfileActivationRequestEmail] Email credentials not configured.");
        return;
    }

    const baseUrl = resolveFrontendBaseUrl(req);
    const profileUrl = employeeId ? `${baseUrl}/emp/${encodeURIComponent(employeeId)}` : baseUrl;
    const siteHost = resolveFrontendHostLabel(req);

    const transporter = nodemailer.createTransport({
        host: "smtp.office365.com",
        port: 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass },
    });

    const isResubmission = String(activationTypeLabel).toLowerCase() === "reactivation";
    const typeForDisplay = isResubmission ? "Reactivation (Resubmission)" : "New Activation";
    const submitterDisplay = submitterName
        ? `${submitterName}${isAdminSubmitter ? " (Administrator)" : ""}`
        : isAdminSubmitter
          ? "Administrator"
          : "";

    const subject = buildEmployeeActivationHrEmailSubject({
        employeeName,
        typeForDisplay,
        isAdminSubmitter,
    });

    const pendingFromText = pendingCardsText
        ? String(pendingCardsText)
              .split(",")
              .map((c) => c.trim())
              .filter(Boolean)
              .map((card) => ({ card, proposedData: {} }))
        : [];

    const html = buildEmployeeActivationHrEmailHtml({
        hrName,
        employeeName,
        employeeId,
        profileUrl,
        typeForDisplay,
        submitterName: submitterDisplay,
        isAdminSubmitter,
        adminDirectApplied,
        reason: reason || (adminDirectApplied ? "Administrator applied profile changes directly" : "Profile submitted for activation review"),
        description: description || "",
        pendingChanges: pendingChanges?.length ? pendingChanges : pendingFromText,
        siteHost,
    });

    await transporter.sendMail({
        fromName: submitterDisplay || "VeRP Portal",
        to,
        subject,
        html,
    });
}
