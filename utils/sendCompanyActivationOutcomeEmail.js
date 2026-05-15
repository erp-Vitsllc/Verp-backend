import nodemailer from "nodemailer";

import { pickEffectiveEmail as pickEmployeeEmail } from "./pickEffectiveEmail.js";

/**
 * Email the company activation submitter when HR approves or rejects.
 */
export async function sendCompanyActivationOutcomeEmail({
    recipientEmployee,
    companyName = "Company",
    companyCode = "",
    companyMongoId = "",
    manager,
    status,
    reason = "",
}) {
    try {
        if (!recipientEmployee) {
            console.warn("[sendCompanyActivationOutcomeEmail] No recipient; skip.");
            return;
        }
        const to = pickEmployeeEmail(recipientEmployee);
        if (!to) {
            console.warn("[sendCompanyActivationOutcomeEmail] Recipient has no email; skip.");
            return;
        }
        const emailUser = process.env.EMAIL_USER?.trim();
        const emailPass = process.env.EMAIL_PASS?.trim();
        if (!emailUser || !emailPass) {
            console.warn("[sendCompanyActivationOutcomeEmail] Email not configured.");
            return;
        }
        const baseUrl = process.env.FRONTEND_URL || "http://localhost:3000";
        const companyUrl = companyMongoId ? `${baseUrl}/Company/${encodeURIComponent(companyMongoId)}` : baseUrl;

        const managerName =
            manager?.name ||
            `${manager?.firstName || ""} ${manager?.lastName || ""}`.trim() ||
            "HR";
        const recipientName =
            `${recipientEmployee.firstName || ""} ${recipientEmployee.lastName || ""}`.trim() || "there";
        const isApproved = String(status || "").toLowerCase() === "active" || String(status || "").toLowerCase() === "approved";

        const transporter = nodemailer.createTransport({
            host: "smtp.office365.com",
            port: 587,
            secure: false,
            auth: { user: emailUser, pass: emailPass },
        });

        const subject = isApproved
            ? `Company activation approved: ${companyName}`
            : `Company activation rejected: ${companyName}`;

        const html = `
            <div style="font-family:Segoe UI,Arial,sans-serif;color:#1e293b;line-height:1.55;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
                <div style="background:${isApproved ? "#059669" : "#e11d48"};color:#fff;padding:18px;text-align:center;">
                    <h2 style="margin:0;font-size:18px;">Company activation ${isApproved ? "approved" : "update"}</h2>
                </div>
                <div style="padding:24px;">
                    <p>Hello <strong>${recipientName}</strong>,</p>
                    <p>The company activation you submitted for <strong>${companyName}</strong>${companyCode ? ` (ID: ${companyCode})` : ""} has been <strong>${isApproved ? "approved" : "rejected"}</strong> by ${managerName}.</p>
                    ${!isApproved && reason ? `<p><strong>Reason:</strong> ${String(reason).replace(/</g, " ")}</p>` : ""}
                    <p style="text-align:center;margin:28px 0;">
                        <a href="${companyUrl}" style="background:#2563eb;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold;">Open company in VeRP</a>
                    </p>
                </div>
            </div>
        `;

        await transporter.sendMail({
            fromName: managerName,
            to,
            subject,
            html,
        });
    } catch (e) {
        console.error("[sendCompanyActivationOutcomeEmail]", e?.message || e);
    }
}
