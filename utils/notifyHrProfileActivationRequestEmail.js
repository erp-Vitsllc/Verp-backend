import nodemailer from "nodemailer";

/**
 * Lightweight HR inbox email when a profile is queued for activation (e.g. submit-approval API without full form body).
 */
export async function notifyHrProfileActivationRequestEmail({
    hrEmail,
    hrName = "HR",
    employeeName = "Employee",
    employeeId = "",
    activationTypeLabel = "Activation",
    pendingCardsText = "",
    submitterName = "",
}) {
    const to = (hrEmail || "").trim();
    if (!to) return;

    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!emailUser || !emailPass) {
        console.warn("[notifyHrProfileActivationRequestEmail] Email credentials not configured.");
        return;
    }

    const baseUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const profileUrl = employeeId ? `${baseUrl}/emp/${encodeURIComponent(employeeId)}` : baseUrl;

    const transporter = nodemailer.createTransport({
        host: "smtp.office365.com",
        port: 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass },
    });

    const isResubmission = String(activationTypeLabel).toLowerCase() === "reactivation";
    const typeForDisplay = isResubmission ? "Reactivation (Resubmission)" : "New Activation";
    const subject = `${typeForDisplay} request: ${employeeName}`.trim();
    const html = `
        <div style="font-family:Segoe UI,Arial,sans-serif;color:#1e293b;line-height:1.55;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
            <div style="background:#2563eb;color:#fff;padding:18px;text-align:center;">
                <h2 style="margin:0;font-size:18px;">Profile activation — action required</h2>
            </div>
            <div style="padding:24px;">
                <p>Hello <strong>${hrName}</strong>,</p>
                <p>A profile was submitted for <strong>${typeForDisplay}</strong>${submitterName ? ` by <strong>${submitterName}</strong> via VeRP` : " through VeRP"}.</p>
                <p><strong>Employee:</strong> ${employeeName}<br/><strong>Employee ID:</strong> ${employeeId || "—"}</p>
                <p><strong>Type:</strong> ${typeForDisplay}</p>
                ${pendingCardsText ? `<p><strong>Requested changes:</strong> ${pendingCardsText}</p>` : ""}
                <p style="text-align:center;margin:28px 0;">
                    <a href="${profileUrl}" style="background:#2563eb;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold;">Review in VeRP</a>
                </p>
            </div>
        </div>
    `;

    await transporter.sendMail({
        fromName: submitterName || "VeRP Portal",
        to,
        subject,
        html,
    });
}
