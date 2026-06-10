import nodemailer from "nodemailer";
import { resolveFrontendBaseUrl, emailFrontendUrl } from './resolveFrontendBaseUrl.js';

const escapeHtmlBasic = (s) =>
    String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

export const sendCompanyActivationHoldEmail = async ({
    recipientEmail,
    recipientName,
    companyName,
    companyCode,
    companyPageId,
    hrManager,
    unapprovedCards = [],
    /** @type {{ cardLabel?: string; note?: string }[]} */
    holdLineItems,
    comment = "",
    approvedCount = 0,
    rejectedCount = 0,
    totalCount = 0,
}) => {
    const to = String(recipientEmail || "").trim();
    if (!to) return;
    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!emailUser || !emailPass) return;

    const transporter = nodemailer.createTransport({
        host: "smtp.office365.com",
        port: 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass },
    });

    const hrName = (() => {
        const m = hrManager;
        if (!m) return "HR";
        if (m.name && String(m.name).trim()) return String(m.name).trim();
        const n = `${m.firstName || ""} ${m.lastName || ""}`.trim();
        return n || "HR";
    })();

    const baseUrl = resolveFrontendBaseUrl();
    const items =
        Array.isArray(holdLineItems) && holdLineItems.some((x) => x && String(x.cardLabel || "").trim())
            ? holdLineItems.filter((x) => x && String(x.cardLabel || "").trim())
            : (unapprovedCards || []).filter(Boolean).map((card) => ({ cardLabel: String(card).trim(), note: "" }));

    const listHtml = items.length
        ? `<ul style="margin:12px 0;padding-left:20px;">${items
              .map((it) => {
                  const label = escapeHtmlBasic(it.cardLabel);
                  const nt = escapeHtmlBasic(String(it.note || "").trim()).replace(/\n/g, "<br/>");
                  return `<li style="margin:8px 0;"><strong>${label}</strong>${nt ? `<div style="margin-top:6px;color:#334155;font-size:14px;line-height:1.5;"><em>Instructions:</em> ${nt}</div>` : ""}</li>`;
              })
              .join("")}</ul>`
        : "<p>Open the company profile in VeRP for details.</p>";
    const commentBlock =
        comment && String(comment).trim()
            ? `<div style="background:#fef3c7;padding:14px;border-radius:8px;margin:18px 0;"><strong>HR note:</strong><br/>${String(comment).trim().replace(/\n/g, "<br/>")}</div>`
            : "";

    const total = Number(totalCount) || approvedCount + rejectedCount;
    const summaryBlock =
        total > 0
            ? `<div style="background:#f1f5f9;padding:14px;border-radius:8px;margin:16px 0;">
                <p style="margin:0;"><strong>HR review summary:</strong></p>
                <p style="margin:8px 0 0;"><strong>${approvedCount}</strong> approved · <strong>${rejectedCount}</strong> need correction (of ${total} requested)</p>
               </div>`
            : "";

    await transporter.sendMail({
        fromName: hrName,
        to,
        subject: `Company activation — ${approvedCount} approved, ${rejectedCount} need updates (${companyName})`,
        html: `
            <div style="font-family:Segoe UI,Arial,sans-serif;line-height:1.6;color:#1e293b;max-width:600px;margin:0 auto;">
                <p>Hello <strong>${recipientName || "there"}</strong>,</p>
                <p>${hrName} reviewed the activation request for <strong>${companyName}</strong> (${companyCode || "N/A"}).</p>
                ${summaryBlock}
                <p><strong>Sections needing your updates:</strong></p>
                ${listHtml}
                ${commentBlock}
                <p>Open your VeRP dashboard task or company profile to edit held items, remove a pending update, or submit for activation again when ready.</p>
                <p style="margin-top:24px;"><a href="${baseUrl}/Company/${encodeURIComponent(String(companyPageId || companyCode || ""))}" style="display:inline-block;background:#1d4ed8;color:#fff;padding:11px 20px;text-decoration:none;border-radius:8px;font-weight:600;">Open company profile</a></p>
            </div>
        `,
    }).catch(() => {});
};
