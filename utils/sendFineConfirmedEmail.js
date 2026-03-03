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

        const recipientEmails = new Set();

        // 1. Add Employee Emails
        fullEmployees.forEach(emp => {
            const mail = emp.companyEmail || emp.personalEmail;
            if (mail) recipientEmails.add(mail);

            // 2. Add Manager Emails (His Reportee/Supervisor)
            if (emp.primaryReportee) {
                const managerMail = emp.primaryReportee.companyEmail || emp.primaryReportee.personalEmail;
                if (managerMail) recipientEmails.add(managerMail);
            }
        });

        // 3. Add Creator Email
        if (creator) {
            const creatorMail = creator.companyEmail || creator.email;
            if (creatorMail) recipientEmails.add(creatorMail);
        }

        const recipients = Array.from(recipientEmails);

        if (recipients.length === 0) {
            console.warn('[FineConfirmedEmail] No valid email addresses found for anyone.');
            return;
        }

        console.log(`[FineConfirmedEmail] Sending to ${recipients.length} recipients: ${recipients.join(', ')}`);

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

        // 3. Prepare Attachments
        const attachments = [];

        // --- Generate Fine Form PDF via Puppeteer ---
        if (req) {
            try {
                const { generatePdf } = await import("./generatePdf.js");
                let pdfBuffer = null;

                if (req.body && req.body.finePdf) {
                    console.log(`[FineConfirmedEmail] Received frontend-generated Base64 Fine Form PDF. Length: ${req.body.finePdf.length}`);
                    let base64Data = req.body.finePdf;
                    if (base64Data.includes(',')) {
                        console.log("[FineConfirmedEmail] Stripping Data URI prefix from finePdf");
                        base64Data = base64Data.split(',')[1];
                    }
                    pdfBuffer = Buffer.from(base64Data, 'base64');
                    console.log(`[FineConfirmedEmail] Converted to Buffer. Size: ${pdfBuffer.length} bytes`);
                } else {
                    const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
                    const baseUrl = origin || process.env.FRONTEND_URL || "http://localhost:3000";
                    const printUrl = `${baseUrl}/print/fine/${fine._id || fine.fineId}`;
                    const token = req.headers.authorization?.split(' ')[1] || '';

                    // Build User Payload for Puppeteer
                    const requestingUserId = req.user?.id || req.user?._id;
                    let userPayload = { id: requestingUserId, role: req.user?.role || 'Admin', isAdmin: req.user?.isAdmin || false };

                    const permissions = { hrm_fine: { isView: true, isActive: true } };
                    const selector = '#fine-form-container';

                    console.log(`[FineConfirmedEmail] Generating Fine PDF via Puppeteer for: ${printUrl}`);
                    pdfBuffer = await generatePdf(printUrl, token, userPayload, permissions, selector);
                    console.log(`[FineConfirmedEmail] Puppeteer Fine PDF generated. Size: ${pdfBuffer ? pdfBuffer.length : 0} bytes`);
                }

                if (pdfBuffer && pdfBuffer.length > 1000) {
                    attachments.push({
                        filename: `FineForm-${fine.fineId || fine._id}.pdf`,
                        content: pdfBuffer,
                        contentType: 'application/pdf'
                    });
                    console.log(`[FineConfirmedEmail] Generated Fine Form PDF added to email.`);
                }
            } catch (pdfErr) {
                console.error("[FineConfirmedEmail] PDF Generation Error:", pdfErr.message);
            }
        }

        // --- Original Attachment via S3 ---
        if (fine.attachment && (fine.attachment.url || fine.attachment.publicId)) {
            try {
                const { getSignedFileUrl } = await import("./s3Upload.js");
                const refreshedUrl = await getSignedFileUrl(fine.attachment.publicId || fine.attachment.url);

                if (!refreshedUrl) throw new Error("Could not generate signed URL for attachment.");

                const rawUrl = String(refreshedUrl);

                // Only block explicit local loops. Allow any valid S3/Storage domain.
                if (rawUrl.includes('localhost') || rawUrl.includes('127.0.0.1')) {
                    throw new Error(`SSRF Blocked: Invalid attachment URL signature: ${rawUrl}`);
                }

                // Fetch the file stream from the URL (S3)
                const response = await axios.get(rawUrl, {
                    responseType: 'arraybuffer',
                    timeout: 30000,
                    maxContentLength: Infinity
                });

                attachments.push({
                    filename: fine.attachment.name || `original_attached_doc.pdf`,
                    content: Buffer.from(response.data)
                });
                console.log('[FineConfirmedEmail] Original attachment retrieved successfully.');
            } catch (err) {
                console.error('[FineConfirmedEmail] Failed to fetch original attachment:', err.message);
                // Proceed without original attachment if it fails
            }
        }

        // 4. Email Content
        const subject = `Fine Notification: #${fine.fineId} Approved`;

        const html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 8px;">
                <h2 style="color: #d9534f; margin-bottom: 20px;">Fine Notification</h2>
                
                <p>Dear Employee,</p>
                
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
                            <td style="padding: 8px 0; color: #666;">Total Amount:</td>
                            <td style="padding: 8px 0; font-weight: bold; color: #d9534f;">${Number(fine.fineAmount).toLocaleString()} AED</td>
                        </tr>
                         <tr>
                            <td style="padding: 8px 0; color: #666;">Your Liability:</td>
                            <td style="padding: 8px 0; font-weight: bold;">${(Number(fine.employeeAmount) / (fine.assignedEmployees.length || 1)).toLocaleString()} AED</td>
                        </tr>
                    </table>
                </div>

                <p>The relevant documentation is attached to this email for your reference.</p>
                
                <p style="font-size: 12px; color: #999; margin-top: 30px; border-top: 1px solid #eee; padding-top: 10px;">
                    This is an automated message from the VERP System. Please do not reply directly to this email.
                </p>
            </div>
        `;

        // 5. Send Email
        await transporter.sendMail({
            from: `"VERP System" <${process.env.EMAIL_USER}>`,
            to: recipients, // Array of emails
            subject: subject,
            html: html,
            attachments: attachments
        });

        console.log('[FineConfirmedEmail] Email sent successfully.');

    } catch (error) {
        console.error('[FineConfirmedEmail] Error sending email:', error);
        // Don't block the main flow if email fails
    }
};
