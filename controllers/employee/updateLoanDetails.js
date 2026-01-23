import nodemailer from "nodemailer";
import Loan from "../../models/Loan.js";
import { getCompleteEmployee } from "../../services/employeeService.js";

export const updateLoanDetails = async (req, res) => {
    const { id } = req.params;
    const { type, amount, duration, reason } = req.body;

    try {
        const loan = await Loan.findById(id);
        if (!loan) {
            return res.status(404).json({ message: "Loan request not found" });
        }

        // Update fields
        loan.type = type || loan.type;
        loan.amount = amount || loan.amount;
        loan.duration = duration || loan.duration;
        loan.reason = reason || loan.reason;

        const savedLoan = await loan.save();

        // Send Email Notification about Update
        const employeeObjectId = loan.employeeObjectId;
        const employeeBasic = await getCompleteEmployee(employeeObjectId);

        if (employeeBasic) {
            const reportee = employeeBasic.primaryReportee;
            if (reportee) {
                const reporteeEmail = reportee.companyEmail || reportee.workEmail || reportee.email;
                if (reporteeEmail) {
                    const emailUser = process.env.EMAIL_USER?.trim();
                    const emailPass = process.env.EMAIL_PASS?.trim();

                    if (emailUser && emailPass) {
                        const transporter = nodemailer.createTransport({
                            host: "smtp.office365.com",
                            port: 587,
                            secure: false,
                            auth: { user: emailUser, pass: emailPass }
                        });

                        const employeeName = `${employeeBasic.firstName || ""} ${employeeBasic.lastName || ""}`.trim();
                        const reporteeName = `${reportee.firstName || ""} ${reportee.lastName || ""}`.trim();
                        const subject = `UPDATED ${type} Application: ${employeeName}`;

                        const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
                        const baseUrl = origin || process.env.FRONTEND_URL || "http://localhost:3000";
                        const actionUrl = `${baseUrl}/HRM/LoanAndAdvance/${savedLoan._id}`;

                        const html = `
                             <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 10px; overflow: hidden;">
                                 <div style="background-color: #3b82f6; color: white; padding: 20px; text-align: center;">
                                     <h2 style="margin: 0;">${type} Application Updated</h2>
                                 </div>
                                 <div style="padding: 30px;">
                                     <p>Hello <strong>${reporteeName}</strong>,</p>
                                     <p><strong>${employeeName}</strong> has updated their request for ${type}.</p>
                                     
                                     <div style="background-color: #eff6ff; padding: 20px; border-radius: 8px; border: 1px solid #dbeafe; margin: 25px 0;">
                                         <p style="margin: 0;"><strong>Employee:</strong> ${employeeName} (${loan.employeeId})</p>
                                         <p style="margin: 8px 0 0 0;"><strong>Type:</strong> ${type}</p>
                                         <p style="margin: 8px 0 0 0;"><strong>New Amount:</strong> ${Number(amount).toLocaleString()}</p>
                                         <p style="margin: 8px 0 0 0;"><strong>New Duration:</strong> ${duration} Months</p>
                                          <p style="margin: 8px 0 0 0;"><strong>Reason:</strong> ${reason}</p>
                                     </div>
                                     
                                     <p style="text-align: center; margin: 35px 0;">
                                         <a href="${actionUrl}" style="background-color: #3b82f6; color: white; padding: 14px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; font-size: 16px;">View Updated Request</a>
                                     </p>
                                 </div>
                             </div>
                         `;

                        await transporter.sendMail({
                            from: `"VeRP Portal" <${emailUser}>`,
                            to: reporteeEmail,
                            subject,
                            html
                        });
                    }
                }
            }
        }

        res.status(200).json({ message: "Loan details updated successfully", loan: savedLoan });

    } catch (error) {
        console.error("Error updating loan details:", error);
        if (error.name === 'CastError') {
            return res.status(400).json({ message: "Invalid loan ID format" });
        }
        res.status(500).json({ message: "Failed to update loan details" });
    }
};
