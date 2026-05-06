import nodemailer from "nodemailer";

const pickEmployeeEmail = (emp) =>
    (emp?.companyEmail || "").trim();

/**
 * HR activation outcome email: **only** the submitter (`recipientEmployee`). Never mails the profile subject.
 * Caller must resolve `profileActivationSubmittedBy` → EmployeeBasic lean; otherwise no email is sent.
 *
 * @param {object} employee — profile subject (context + link target)
 * @param {object|null} recipientEmployee — activation submitter (required to send)
 */
export const sendProfileNotification = async ({ employee, recipientEmployee = null, manager, status, reason = "" }) => {
    try {
        const profileSubjectName = `${employee.firstName || ""} ${employee.lastName || ""}`.trim() || "Employee";

        if (!recipientEmployee) {
            console.warn(
                `[Email] Activation ${status} skipped — no submitter on file (subject employeeId ${employee.employeeId})`,
            );
            return;
        }

        const recipientEmail = pickEmployeeEmail(recipientEmployee);
        if (!recipientEmail) {
            console.warn(
                `[Email] Activation ${status} skipped — submitter has no email (subject employeeId ${employee.employeeId})`,
            );
            return;
        }

        const emailUser = process.env.EMAIL_USER?.trim();
        const emailPass = process.env.EMAIL_PASS?.trim();

        if (!emailUser || !emailPass) {
            console.error("[Email Error] Email credentials are not configured.");
            return;
        }

        const transporter = nodemailer.createTransport({
            host: "smtp.office365.com",
            port: 587,
            secure: false,
            auth: {
                user: emailUser,
                pass: emailPass,
            },
        });

        const recipientName =
            `${recipientEmployee.firstName || ""} ${recipientEmployee.lastName || ""}`.trim() ||
            "there";

        const managerName = (() => {
            const m = manager;
            if (!m) return "HR";
            if (m.name && String(m.name).trim()) return String(m.name).trim();
            const n = `${m.firstName || ""} ${m.lastName || ""}`.trim();
            if (n) return n;
            if (m.email) return m.email;
            return "HR";
        })();

        const isApproved = status.toLowerCase() === "active" || status.toLowerCase() === "approved";

        const sameRecipientAsSubject =
            String(recipientEmployee._id || recipientEmployee.id || "") ===
            String(employee._id || employee.id || "");

        const subject = isApproved
            ? sameRecipientAsSubject
                ? `Your VeRP Profile has been Activated!`
                : `Profile activation approved: ${profileSubjectName}`
            : sameRecipientAsSubject
              ? `Update Required: Profile Activation Request`
              : `Profile activation rejected: ${profileSubjectName}`;

        const approvedBody = sameRecipientAsSubject
            ? `<p>Great news! Your profile activation request has been <strong>approved</strong> by ${managerName}. Your account is now fully active.</p>
               <p>You can now access all portal features including Salary Slips, Leave Applications, and Loan Requests.</p>`
            : `<p>The profile activation you submitted for <strong>${profileSubjectName}</strong> (Employee ID: <strong>${employee.employeeId || "—"}</strong>) has been <strong>approved</strong> by ${managerName}. That employee’s account is now fully active.</p>`;

        const rejectedBody = sameRecipientAsSubject
            ? `<p>Your profile activation request has been <strong>rejected</strong> by ${managerName}. Please review the feedback below and update your profile details.</p>
               <p>Once you've made the necessary changes, you can resubmit your profile for activation.</p>`
            : `<p>The profile activation you submitted for <strong>${profileSubjectName}</strong> (Employee ID: <strong>${employee.employeeId || "—"}</strong>) has been <strong>rejected</strong> by ${managerName}. Please review the feedback and update that employee’s profile before sending for activation again.</p>`;

        const html = `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1e293b; line-height: 1.6; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background-color: #ffffff;">
                <div style="background-color: ${isApproved ? "#059669" : "#e11d48"}; color: white; padding: 30px; text-align: center;">
                    <h1 style="margin: 0; font-size: 24px;">Profile ${isApproved ? "Activated" : "Action Required"}</h1>
                </div>
                <div style="padding: 40px;">
                    <p style="font-size: 16px;">Hello <strong>${recipientName}</strong>,</p>
                    
                    ${isApproved ? approvedBody : rejectedBody}

                    ${
                        !isApproved && reason
                            ? `
                        <div style="background-color: #fff1f2; padding: 20px; border-left: 4px solid #e11d48; border-radius: 4px; margin: 25px 0;">
                            <p style="margin: 0; font-weight: bold; color: #9f1239;">Feedback:</p>
                            <p style="margin: 8px 0 0 0; color: #be123b;">${reason}</p>
                        </div>
                    `
                            : ""
                    }

                    <div style="text-align: center; margin-top: 40px;">
                        <a href="${process.env.FRONTEND_URL || "http://localhost:3000"}/emp/${employee.employeeId}" 
                           style="background-color: ${isApproved ? "#059669" : "#1e293b"}; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block; font-size: 15px;">
                           ${sameRecipientAsSubject ? "View My Profile" : "Open employee profile"}
                        </a>
                    </div>
                </div>
                <div style="background-color: #f8fafc; padding: 20px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0;">
                    <p style="margin: 0;">This is an automated notification from the VeRP Portal.</p>
                </div>
            </div>
        `;

        await transporter.sendMail({
            from: `"${managerName}" <${emailUser}>`,
            to: [recipientEmail],
            subject,
            html,
        });

        console.log(`[Email Success] ${isApproved ? "Activation" : "Rejection"} email sent to submitter ${recipientEmail}`);
    } catch (error) {
        console.error("[Email Error] Failed to send profile notification email:", error);
    }
};
