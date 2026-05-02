import nodemailer from "nodemailer";

const pickEmployeeEmail = (emp) =>
    emp?.companyEmail || emp?.workEmail || emp?.personalEmail || emp?.email || "";

/**
 * Emails **only** the portal user who submitted for activation (`submitterEmployee` from `profileActivationSubmittedBy`).
 * Does not mail the profile subject. No-op if submitter record or email is missing.
 */
export const sendProfileActivationHoldEmail = async (params) => {
    const { subjectEmployee, submitterEmployee = null, hrManager, unapprovedCards = [], comment = "" } = params;
    const employee = subjectEmployee;
    if (!employee) return;

    if (!submitterEmployee) {
        console.warn(
            `[hold email] Skipped — no activation submitter (profileActivationSubmittedBy) for employeeId ${employee.employeeId}`,
        );
        return;
    }

    const toEmail = pickEmployeeEmail(submitterEmployee).trim();
    if (!toEmail) {
        console.warn(
            `[hold email] Skipped — submitter has no email (subject employeeId ${employee.employeeId})`,
        );
        return;
    }

    try {
        const emailUser = process.env.EMAIL_USER?.trim();
        const emailPass = process.env.EMAIL_PASS?.trim();
        if (!emailUser || !emailPass) return;

        const transporter = nodemailer.createTransport({
            host: "smtp.office365.com",
            port: 587,
            secure: false,
            auth: { user: emailUser, pass: emailPass },
        });

        const profileName = `${employee.firstName || ""} ${employee.lastName || ""}`.trim() || "Employee";
        const greetingName =
            `${submitterEmployee.firstName || ""} ${submitterEmployee.lastName || ""}`.trim() ||
            "there";

        const hrName = (() => {
            const m = hrManager;
            if (!m) return "HR";
            if (m.name && String(m.name).trim()) return String(m.name).trim();
            const n = `${m.firstName || ""} ${m.lastName || ""}`.trim();
            return n || "HR";
        })();

        const baseUrl = process.env.FRONTEND_URL || "http://localhost:3000";
        const profileUrl = `${baseUrl}/emp/${employee.employeeId}`;
        const listHtml = unapprovedCards.length
            ? `<ul style="margin:12px 0;padding-left:20px;"><li>${unapprovedCards.join("</li><li>")}</li></ul>`
            : "<p>No specific cards were listed; please open the employee profile to review HR notes.</p>";
        const commentBlock =
            comment && String(comment).trim()
                ? `<div style="background:#fef3c7;padding:14px;border-radius:8px;margin:18px 0;border-left:4px solid #d97706;"><strong>HR note:</strong><br/>${String(comment).trim().replace(/\n/g, "<br/>")}</div>`
                : "";

        const samePerson =
            employee?._id &&
            String(submitterEmployee._id || submitterEmployee.id || "") === String(employee._id || employee.id || "");

        const introSame = `<p>${hrName} reviewed the activation request and placed it <strong>on hold</strong>. The profile is <strong>not activated</strong> until the items below are corrected and you send for reactivation again.</p>`;
        const introOther = `<p>${hrName} reviewed your submitted activation for <strong>${profileName}</strong> (Employee ID: <strong>${employee.employeeId || "—"}</strong>) and placed it <strong>on hold</strong>. The profile is <strong>not activated</strong> until the listed items are addressed and activation is sent again.</p>`;

        const mailOpts = {
            from: `"VeRP Portal" <${emailUser}>`,
            to: toEmail,
            subject: `${profileName}: profile activation — items to update (held by HR)`,
            html: `
                <div style="font-family:Segoe UI,Arial,sans-serif;color:#1e293b;line-height:1.6;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
                    <div style="background:#b45309;color:#fff;padding:22px;">
                        <h1 style="margin:0;font-size:20px;">Activation on hold</h1>
                    </div>
                    <div style="padding:28px;">
                        <p>Hello <strong>${greetingName}</strong>,</p>
                        ${samePerson ? introSame : introOther}
                        <p><strong>Items not approved (please update):</strong></p>
                        ${listHtml}
                        ${commentBlock}
                        <p style="text-align:center;margin-top:28px;">
                            <a href="${profileUrl}" style="background:#1d4ed8;color:#fff;padding:12px 22px;text-decoration:none;border-radius:8px;font-weight:600;display:inline-block;">Open employee profile</a>
                        </p>
                    </div>
                </div>
            `,
        };

        await transporter.sendMail(mailOpts);
    } catch (e) {
        console.error("[sendProfileActivationHoldEmail]", e?.message || e);
    }
};
