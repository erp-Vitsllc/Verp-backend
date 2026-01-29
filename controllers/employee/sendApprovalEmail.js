import nodemailer from "nodemailer";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getCompleteEmployee } from "../../services/employeeService.js";

export const sendApprovalEmail = async (req, res) => {
    const { id } = req.params;

    try {
        // Get complete employee basic data (populates reportees)
        const employeeBasic = await getCompleteEmployee(id);
        if (!employeeBasic) {
            return res.status(404).json({ message: "Employee not found" });
        }

        // Strictly use primaryReportee for activation email
        const reportee = employeeBasic.primaryReportee;

        if (!reportee) {
            return res.status(400).json({ message: "Primary reportee is not assigned for this employee." });
        }

        const reporteeEmail = reportee.companyEmail || reportee.workEmail || reportee.email;
        if (!reporteeEmail) {
            return res.status(400).json({ message: "Reportee email is missing." });
        }

        const emailUser = process.env.EMAIL_USER?.trim();
        const emailPass = process.env.EMAIL_PASS?.trim();

        if (!emailUser || !emailPass) {
            return res.status(500).json({ message: "Email credentials are not configured on the server." });
        }

        // Outlook configuration
        const transporter = nodemailer.createTransport({
            host: "smtp.office365.com",
            port: 587,
            secure: false, // true for 587 (TLS)
            auth: {
                user: emailUser,
                pass: emailPass
            }
        });

        const employeeName = `${employeeBasic.firstName || ""} ${employeeBasic.lastName || ""}`.trim() || "Employee";
        const reporteeName = `${reportee.firstName || ""} ${reportee.lastName || ""}`.trim();
        const subject = `Profile activation request: ${employeeName}`;

        // Dynamic URL logic - Prioritize environment variable, then request headers
        const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
        const baseUrl = process.env.FRONTEND_URL || origin || "http://localhost:3000";
        console.log(`[Email Debug] Using Base URL for links: ${baseUrl}`);
        const profileUrl = `${baseUrl}/emp/${employeeBasic.employeeId}`;

        const html = `
            <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 10px; overflow: hidden;">
                <div style="background-color: #2563eb; color: white; padding: 20px; text-align: center;">
                    <h2 style="margin: 0;">Profile Activation Request</h2>
                </div>
                <div style="padding: 30px;">
                    <p>Hello <strong>${reporteeName || "Team"}</strong>,</p>
                    <p>Greetings from VeRP Portal.</p>
                    <p>The following employee has completed their profile and is requesting activation. As their designated reportee, please review the profile and grant activation if everything is in order.</p>
                    
                    <div style="background-color: #f8fafc; padding: 20px; border-radius: 8px; border: 1px solid #e2e8f0; margin: 25px 0;">
                        <p style="margin: 0;"><strong>Employee Name:</strong> ${employeeName}</p>
                        <p style="margin: 8px 0 0 0;"><strong>Employee ID:</strong> ${employeeBasic.employeeId || "N/A"}</p>
                        <p style="margin: 8px 0 0 0;"><strong>Department:</strong> ${employeeBasic.department || "N/A"}</p>
                        <p style="margin: 8px 0 0 0;"><strong>Designation:</strong> ${employeeBasic.designation || "N/A"}</p>
                    </div>
                    
                    <p style="text-align: center; margin: 35px 0;">
                        <a href="${profileUrl}" style="background-color: #2563eb; color: white; padding: 14px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; font-size: 16px;">View & Activate Profile</a>
                    </p>
                    

                </div>
            </div>
        `;

        console.log(`[Email Debug] Attempting to send email from: ${emailUser}`);
        console.log(`[Email Debug] To: ${reporteeEmail}`);
        console.log(`[Email Debug] Subject: ${subject}`);

        await transporter.sendMail({
            from: `"VeRP Portal" <${emailUser}>`,
            to: reporteeEmail,
            subject,
            html
        });
        console.log("[Email Debug] Email sent successfully via transporter.");

        // Update profile approval status
        await EmployeeBasic.findByIdAndUpdate(employeeBasic._id, {
            profileApprovalStatus: "submitted"
        });

        return res.status(200).json({ message: "Approval request sent successfully." });
    } catch (error) {
        console.error("Failed to send approval email:", error);
        console.error("Error Code:", error?.code);
        console.error("Error Command:", error?.command);
        return res.status(500).json({ message: error.message || "Failed to send approval email." });
    }
};


