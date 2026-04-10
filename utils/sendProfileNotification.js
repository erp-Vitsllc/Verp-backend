import nodemailer from "nodemailer";

export const sendProfileNotification = async ({ employee, manager, status, reason = "" }) => {
    try {
        const employeeEmail =
            employee.companyEmail || employee.workEmail || employee.personalEmail || employee.email;
        if (!employeeEmail) {
            console.warn(`[Email Warning] No email found for employee ${employee.employeeId}`);
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
            secure: false, // true for 587 (TLS)
            auth: {
                user: emailUser,
                pass: emailPass
            }
        });

        const employeeName = `${employee.firstName || ""} ${employee.lastName || ""}`.trim();
        const managerName = (() => {
            const m = manager;
            if (!m) return "HR";
            if (m.name && String(m.name).trim()) return String(m.name).trim();
            const n = `${m.firstName || ""} ${m.lastName || ""}`.trim();
            if (n) return n;
            if (m.email) return m.email;
            return "HR";
        })();

        const isApproved = status.toLowerCase() === 'active' || status.toLowerCase() === 'approved';

        let recipientList = [employeeEmail];

        if (!isApproved) {
            // Fetch Previous Approvers from profileWorkflow
            const previousApprovers = (employee.profileWorkflow || [])
                .filter(w => w.status === 'active' && w.assignedTo);

            if (previousApprovers.length > 0) {
                // We need to fetch their emails. Since we might not have a direct ref here, 
                // and this is utility, we should ideally have passed them or we'll do a quick fetch
                try {
                    const EmployeeBasic = (await import("../models/EmployeeBasic.js")).default;
                    const approverIds = previousApprovers.map(p => p.assignedTo);
                    const approverEmps = await EmployeeBasic.find({ _id: { $in: approverIds } })
                        .select('companyEmail workEmail email');

                    const approverEmails = approverEmps
                        .map(ae => ae.companyEmail || ae.workEmail || ae.email)
                        .filter(e => e);

                    recipientList = [...new Set([...recipientList, ...approverEmails])];
                } catch (fetchErr) {
                    console.error("[Email Error] Failed to fetch previous approver emails:", fetchErr);
                }
            }
        }

        const subject = isApproved
            ? `Your VeRP Profile has been Activated!`
            : `Update Required: Profile Activation Request`;

        const html = `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1e293b; line-height: 1.6; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background-color: #ffffff;">
                <div style="background-color: ${isApproved ? '#059669' : '#e11d48'}; color: white; padding: 30px; text-align: center;">
                    <h1 style="margin: 0; font-size: 24px;">Profile ${isApproved ? 'Activated' : 'Action Required'}</h1>
                </div>
                <div style="padding: 40px;">
                    <p style="font-size: 16px;">Hello <strong>${employeeName}</strong>,</p>
                    
                    ${isApproved ?
                `<p>Great news! Your profile activation request has been <strong>approved</strong> by ${managerName}. Your account is now fully active.</p>` :
                `<p>Your profile activation request has been <strong>rejected</strong> by ${managerName}. Please review the feedback below and update your profile details.</p>`
            }

                    ${!isApproved && reason ? `
                        <div style="background-color: #fff1f2; padding: 20px; border-left: 4px solid #e11d48; border-radius: 4px; margin: 25px 0;">
                            <p style="margin: 0; font-weight: bold; color: #9f1239;">Feedback:</p>
                            <p style="margin: 8px 0 0 0; color: #be123b;">${reason}</p>
                        </div>
                    ` : ''}

                    ${isApproved ? `
                        <p>You can now access all portal features including Salary Slips, Leave Applications, and Loan Requests.</p>
                    ` : `
                        <p>Once you've made the necessary changes, you can resubmit your profile for activation.</p>
                    `}

                    <div style="text-align: center; margin-top: 40px;">
                        <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/emp/${employee.employeeId}" 
                           style="background-color: ${isApproved ? '#059669' : '#1e293b'}; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block; font-size: 15px;">
                           View My Profile
                        </a>
                    </div>
                </div>
                <div style="background-color: #f8fafc; padding: 20px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0;">
                    <p style="margin: 0;">This is an automated notification from the VeRP Portal.</p>
                </div>
            </div>
        `;

        await transporter.sendMail({
            from: `"VeRP Portal" <${emailUser}>`,
            to: recipientList,
            subject,
            html
        });

        console.log(`[Email Success] ${isApproved ? 'Activation' : 'Rejection'} email sent to ${employeeEmail}`);
    } catch (error) {
        console.error("[Email Error] Failed to send profile notification email:", error);
    }
};
