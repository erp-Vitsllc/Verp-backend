import nodemailer from 'nodemailer';
import EmployeeBasic from '../models/EmployeeBasic.js';
import axios from 'axios';

/**
 * Sends a confirmation email to assigned employees when a fine is fully approved.
 * Includes the fine attachment if available.
 * 
 * @param {Object} fine - The full fine object
 * @param {Array} assignedEmployees - Array of assigned employee objects from the fine
 */
export const sendFineConfirmedEmail = async (fine, assignedEmployees, req = null) => {
    try {
        console.log(`[FineConfirmedEmail] Preparing email for Fine #${fine.fineId}`);

        // 1. Fetch Employee Emails and their Managers
        const employeeIds = assignedEmployees.map(e => e.employeeId);
        const fullEmployees = await EmployeeBasic.find({ employeeId: { $in: employeeIds } })
            .select('employeeId firstName lastName companyEmail personalEmail primaryReportee')
            .populate('primaryReportee', 'companyEmail personalEmail');

        // Fetch Creator Email (Need User model)
        const User = await import("../models/User.js").then(m => m.default);
        const creator = await User.findById(fine.createdBy).select('email companyEmail').lean();

        const toEmails = new Set();
        const ccEmails = new Set();

        // 1. Add Employee Emails
        fullEmployees.forEach(emp => {
            const mail = emp.companyEmail || emp.personalEmail;
            if (mail) toEmails.add(mail);

            // 2. Add Manager Emails (His Reportee/Supervisor)
            if (emp.primaryReportee) {
                const managerMail = emp.primaryReportee.companyEmail || emp.primaryReportee.personalEmail;
                if (managerMail) ccEmails.add(managerMail);
            }
        });

        // 3. Add Creator Email
        if (creator) {
            const creatorMail = creator.companyEmail || creator.email;
            if (creatorMail) ccEmails.add(creatorMail);
        }

        // 4. Add HR, Accounts, Management
        if (employeeIds.length > 0) {
        // Get HR, Accounts, Management HODs for CC
        try {
            const { getDepartmentHOD } = await import("./getDepartmentHOD.js");
            const { getManagementHOD } = await import("./getManagementHOD.js");

            const hrHOD = await getDepartmentHOD('hr', employeeIds[0]);
            if (hrHOD && (hrHOD.companyEmail || hrHOD.personalEmail || hrHOD.email)) {
                ccEmails.add(hrHOD.companyEmail || hrHOD.personalEmail || hrHOD.email);
            }

            const accountsHOD = await getDepartmentHOD('finance', employeeIds[0]);
            if (accountsHOD && (accountsHOD.companyEmail || accountsHOD.personalEmail || accountsHOD.email)) {
                ccEmails.add(accountsHOD.companyEmail || accountsHOD.personalEmail || accountsHOD.email);
            }

            const managementHOD = await getManagementHOD(employeeIds[0]);
            if (managementHOD && (managementHOD.companyEmail || managementHOD.personalEmail || managementHOD.email)) {
                ccEmails.add(managementHOD.companyEmail || managementHOD.personalEmail || managementHOD.email);
            }
        } catch (err) {
            console.warn("[FineConfirmedEmail] Could not fetch HOD emails for CC", err.message);
        }
        }

        const ccRecipients = Array.from(ccEmails);

        // 2. Transporter Setup
        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || 'smtp.office365.com',
            port: process.env.SMTP_PORT || 587,
            secure: false,
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });

        // 3. Prepare Built-in PDF Attachment (System Generated Fine Form)
        const attachments = [];
        if (req) {
            try {
                const { generatePdf } = await import("./generatePdf.js");
                let pdfBuffer = null;

                if (req.body && req.body.finePdf) {
                    console.log(`[FineConfirmedEmail] Received frontend-generated Base64 Fine Form PDF. Length: ${req.body.finePdf.length}`);
                    let base64Data = req.body.finePdf;
                    if (base64Data.includes(',')) {
                        base64Data = base64Data.split(',')[1];
                    }
                    pdfBuffer = Buffer.from(base64Data, 'base64');
                } else {
                    const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
                    const baseUrl = origin || process.env.FRONTEND_URL || "http://localhost:3000";
                    const printUrl = `${baseUrl}/print/fine/${fine._id || fine.fineId}`;
                    const token = req.headers.authorization?.split(' ')[1] || '';

                    const requestingUserId = req.user?.id || req.user?._id;
                    let userPayload = { id: requestingUserId, role: req.user?.role || 'Admin', isAdmin: req.user?.isAdmin || false };

                    const permissions = { hrm_fine: { isView: true, isActive: true } };
                    const selector = '#fine-form-container';

                    pdfBuffer = await generatePdf(printUrl, token, userPayload, permissions, selector);
                }

                if (pdfBuffer && pdfBuffer.length > 1000) {
                    attachments.push({
                        filename: `FineForm-${fine.fineId || fine._id}.pdf`,
                        content: pdfBuffer,
                        contentType: 'application/pdf'
                    });
                }
            } catch (pdfErr) {
                console.error("[FineConfirmedEmail] PDF Generation Error:", pdfErr.message);
            }
        }

        // Loop through each assigned employee and send Individual emails
        for (const assigned of assignedEmployees) {
            const empDetails = fullEmployees.find(e => e.employeeId === assigned.employeeId);
            if (!empDetails) continue;

            const toMail = empDetails.companyEmail || empDetails.personalEmail;
            if (!toMail) continue;

            const subject = `Fine Notification: #${fine.fineId} Approved`;

            const html = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 8px;">
                    <h2 style="color: #d9534f; margin-bottom: 20px;">Fine Notification</h2>
                    
                    <p>Dear ${assigned.employeeName || empDetails.firstName},</p>
                    
                    <p>This is to inform you that a fine assigned to you has been <strong>approved</strong> and processed.</p>
                    
                    <div style="background-color: #f9f9f9; padding: 15px; border-radius: 6px; margin: 20px 0;">
                        <h3 style="margin-top: 0; color: #333;">Fine Details</h3>
                        <table style="width: 100%; border-collapse: collapse;">
                            <tr>
                                <td style="padding: 8px 0; color: #666; width: 40%;">Fine ID:</td>
                                <td style="padding: 8px 0; font-weight: bold;">${fine.fineId}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #666;">Date Awarded:</td>
                                <td style="padding: 8px 0;">${new Date(fine.awardedDate).toLocaleDateString()}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #666;">Type:</td>
                                <td style="padding: 8px 0;">${fine.fineType} (${fine.category})</td>
                            </tr>
                             <tr>
                                <td style="padding: 8px 0; color: #666;">Description:</td>
                                <td style="padding: 8px 0;">${fine.description || 'N/A'}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #666;">Total Fine Amount:</td>
                                <td style="padding: 8px 0; font-weight: bold; color: #d9534f;">${Number(fine.fineAmount).toLocaleString()} AED</td>
                            </tr>
                             <tr>
                                <td style="padding: 8px 0; color: #666;">Your Liability:</td>
                                <td style="padding: 8px 0; font-weight: bold;">${Number(assigned.employeeAmount || assigned.amount || (fine.employeeAmount / fine.assignedEmployees.length) || 0).toLocaleString()} AED</td>
                            </tr>
                        </table>
                    </div>

                    <p>The system generated fine form is attached to this email for your reference.</p>
                    
                    <p style="font-size: 12px; color: #999; margin-top: 30px; border-top: 1px solid #eee; padding-top: 10px;">
                        This is an automated message from the VERP System.
                    </p>
                </div>
            `;

            await transporter.sendMail({
                from: `"VERP System" <${process.env.EMAIL_USER}>`,
                to: toMail,
                cc: ccRecipients,
                subject: subject,
                html: html,
                attachments: attachments
            });
            console.log(`[FineConfirmedEmail] Sent to ${toMail}`);
        }

        console.log('[FineConfirmedEmail] All individual emails sent successfully.');

    } catch (error) {
        console.error('[FineConfirmedEmail] Error sending email:', error);
        // Don't block the main flow if email fails
    }
};
