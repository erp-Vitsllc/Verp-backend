import nodemailer from "nodemailer";

export const sendProfileActivationHoldEmail = async ({
    employee,
    hodEmployee,
    hrManager,
    unapprovedCards = [],
    comment = "",
}) => {
    try {
        const employeeEmail =
            employee.companyEmail || employee.workEmail || employee.personalEmail || employee.email;
        if (!employeeEmail) {
            console.warn(`[hold email] No email found for employee ${employee.employeeId}`);
            return;
        }

        const hodEmailRaw =
            hodEmployee &&
            String(
                hodEmployee.companyEmail ||
                    hodEmployee.workEmail ||
                    hodEmployee.email ||
                    hodEmployee.personalEmail ||
                    "",
            ).trim();

        const hodEmail =
            hodEmailRaw &&
            hodEmailRaw.toLowerCase() !== String(employeeEmail).toLowerCase()
                ? hodEmailRaw.toLowerCase()
                : "";
        const emailUser = process.env.EMAIL_USER?.trim();
        const emailPass = process.env.EMAIL_PASS?.trim();
        if (!emailUser || !emailPass) return;

        const transporter = nodemailer.createTransport({
            host: "smtp.office365.com",
            port: 587,
            secure: false,
            auth: { user: emailUser, pass: emailPass },
        });

        const employeeName = `${employee.firstName || ""} ${employee.lastName || ""}`.trim();
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
            : "<p>No specific cards were listed; please open your profile to review HR notes.</p>";
        const commentBlock =
            comment && String(comment).trim()
                ? `<div style="background:#fef3c7;padding:14px;border-radius:8px;margin:18px 0;border-left:4px solid #d97706;"><strong>HR note:</strong><br/>${String(comment).trim().replace(/\n/g, "<br/>")}</div>`
                : "";

        const hodName = hodEmployee
            ? `${hodEmployee.firstName || ""} ${hodEmployee.lastName || ""}`.trim() ||
              hodEmployee.name ||
              "Primary manager"
            : "";

        const hodCopy = hodEmail
            ? `
                        <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;" />
                        <p><strong>Note for managers (copied)</strong>${hodName ? ` — ${hodName}` : ''}: activation is <strong>on hold</strong> until pending items listed above are corrected.</p>
                        <p>Open their profile any time:</p>
                        <p style="text-align:center;margin-top:14px;">
                            <a href="${profileUrl}" style="background:#0f766e;color:#fff;padding:10px 18px;text-decoration:none;border-radius:8px;font-weight:600;display:inline-block;">Open employee profile</a>
                        </p>
            `
            : "";

        const mailOpts = {
            from: `"VeRP Portal" <${emailUser}>`,
            to: employeeEmail,
            subject: `${employeeName}: profile activation — items to update (held by HR)`,
            html: `
                <div style="font-family:Segoe UI,Arial,sans-serif;color:#1e293b;line-height:1.6;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
                    <div style="background:#b45309;color:#fff;padding:22px;">
                        <h1 style="margin:0;font-size:20px;">Activation on hold</h1>
                    </div>
                    <div style="padding:28px;">
                        <p>Hello <strong>${employeeName}</strong>,</p>
                        <p>${hrName} reviewed your profile activation and placed it <strong>on hold</strong>. Your profile is <strong>not activated</strong> until these items are corrected and you send for reactivation.</p>
                        <p><strong>Items not approved (please update):</strong></p>
                        ${listHtml}
                        ${commentBlock}
                        ${hodCopy}
                        <p style="text-align:center;margin-top:28px;">
                            <a href="${profileUrl}" style="background:#1d4ed8;color:#fff;padding:12px 22px;text-decoration:none;border-radius:8px;font-weight:600;display:inline-block;">Review profile</a>
                        </p>
                    </div>
                </div>
            `,
        };

        if (hodEmail) {
            mailOpts.cc = hodEmail;
        }

        await transporter.sendMail(mailOpts);
    } catch (e) {
        console.error("[sendProfileActivationHoldEmail]", e?.message || e);
    }
};
