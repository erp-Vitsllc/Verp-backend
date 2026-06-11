import {
    renderEmailAttachmentLineHtml,
    renderEmailPrimaryButton,
    renderEmailSiteFooter,
} from "./emailAccessibleFiles.js";

const escapeHtml = (value = "") =>
    String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

/** Unique card labels from pending queue rows — no field values in email body. */
export function extractPendingCardNames(pendingChanges = []) {
    const list = Array.isArray(pendingChanges) ? pendingChanges : [];
    const seen = new Set();
    const names = [];
    for (const change of list) {
        const card = String(change?.card || change?.reason || "").trim();
        if (!card) continue;
        const key = card.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        names.push(card);
    }
    return names;
}

function renderPendingCardList(pendingChanges = []) {
    const names = extractPendingCardNames(pendingChanges);
    if (!names.length) return "";
    return `
        <div style="margin:16px 0;">
            <p style="margin:0 0 8px;font-size:14px;font-weight:700;color:#1e293b;">Cards to review (${names.length})</p>
            <ul style="margin:0;padding-left:20px;font-size:14px;color:#1e293b;">
                ${names.map((name) => `<li style="margin:4px 0;">${escapeHtml(name)}</li>`).join("")}
            </ul>
            <p style="margin:10px 0 0;font-size:12px;color:#64748b;">Open VeRP to compare current and proposed values.</p>
        </div>`;
}

export function buildEmployeeActivationHrEmailHtml({
    hrName = "HR",
    employeeName = "Employee",
    employeeId = "",
    profileUrl = "",
    typeForDisplay = "New Activation",
    submitterName = "",
    isAdminSubmitter = false,
    adminDirectApplied = false,
    reason = "",
    description = "",
    pendingChanges = [],
    attachmentHtml = "",
    siteHost = "VeRP",
}) {
    const safeHr = escapeHtml(hrName);
    const safeEmployee = escapeHtml(employeeName);
    const safeEid = escapeHtml(employeeId || "—");
    const safeType = escapeHtml(typeForDisplay);
    const safeSubmitter = escapeHtml(submitterName || "VeRP Portal");
    const safeReason = reason ? escapeHtml(reason) : "";

    const adminBanner = adminDirectApplied
        ? `<p style="margin:0 0 12px;padding:10px 12px;background:#ecfdf5;border:1px solid #86efac;border-radius:8px;font-size:13px;color:#166534;"><strong>Administrator applied changes</strong> — the live profile is already updated. This email is for your information only.</p>`
        : isAdminSubmitter
          ? `<p style="margin:0 0 12px;padding:10px 12px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;font-size:13px;color:#9a3412;"><strong>Administrator submission</strong> — review the cards below in VeRP.</p>`
          : "";

    const intro = adminDirectApplied
        ? `<p><strong>${safeSubmitter}</strong> applied profile changes for <strong>${safeEmployee}</strong> (${safeEid}) — <strong>${safeType}</strong>.</p>`
        : isAdminSubmitter
          ? `<p><strong>${safeSubmitter}</strong> submitted <strong>${safeEmployee}</strong> (${safeEid}) for <strong>${safeType}</strong>.</p>`
          : `<p><strong>${safeEmployee}</strong> (${safeEid}) was submitted for <strong>${safeType}</strong>${submitterName && submitterName !== "VeRP Portal" ? ` by <strong>${safeSubmitter}</strong>` : ""}.</p>`;

    const pendingHtml = renderPendingCardList(pendingChanges);

    return `
        <div style="font-family:Segoe UI,Arial,sans-serif;color:#1e293b;line-height:1.5;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
            <div style="background:${isAdminSubmitter ? "#c2410c" : "#2563eb"};color:#fff;padding:16px 20px;text-align:center;">
                <h2 style="margin:0;font-size:17px;">${adminDirectApplied ? "Administrator — Changes Applied" : isAdminSubmitter ? "Administrator — Profile Activation" : "Profile Activation Request"}</h2>
            </div>
            <div style="padding:20px;">
                <p>Hello <strong>${safeHr}</strong>,</p>
                ${adminBanner}
                ${intro}
                <div style="background:#f8fafc;padding:12px 14px;border-radius:8px;border:1px solid #e2e8f0;margin:14px 0;font-size:14px;">
                    <p style="margin:0;"><strong>Employee:</strong> ${safeEmployee}</p>
                    <p style="margin:4px 0 0;"><strong>ID:</strong> ${safeEid}</p>
                    <p style="margin:4px 0 0;"><strong>Type:</strong> ${safeType}</p>
                    ${isAdminSubmitter ? `<p style="margin:4px 0 0;"><strong>Submitted by:</strong> ${safeSubmitter}</p>` : ""}
                    ${safeReason ? `<p style="margin:4px 0 0;"><strong>Reason:</strong> ${safeReason}</p>` : ""}
                </div>
                ${pendingHtml}
                <p style="text-align:center;margin:20px 0;">
                    ${renderEmailPrimaryButton(profileUrl, adminDirectApplied ? "View profile in VeRP" : "Review in VeRP", adminDirectApplied ? "#059669" : isAdminSubmitter ? "#c2410c" : "#2563eb")}
                </p>
                ${attachmentHtml}
                ${renderEmailSiteFooter(siteHost)}
            </div>
        </div>`;
}

export function buildEmployeeActivationHrEmailSubject({
    employeeName = "Employee",
    typeForDisplay = "New Activation",
    isAdminSubmitter = false,
}) {
    const prefix = isAdminSubmitter ? "Administrator submission" : typeForDisplay;
    return `${prefix}: ${employeeName}`.trim();
}

export { renderEmailAttachmentLineHtml };
