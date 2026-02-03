import nodemailer from 'nodemailer';
import EmployeeBasic from '../models/EmployeeBasic.js';
import axios from 'axios';
import { isValidStorageUrl } from './validationHelper.js';

/**
 * Sends a rejection email to assigned employees when a fine is rejected by CEO/Admin.
 * 
 * @param {Object} fine - The full fine object
 * @param {Array} assignedEmployees - Array of assigned employee objects from the fine
 */
export const sendFineRejectedEmail = async (fine, assignedEmployees) => {
    try {
        console.log(`[FineRejectedEmail] Preparing rejection email for Fine #${fine.fineId}`);

        // 1. Fetch Employee Emails
        const employeeIds = assignedEmployees.map(e => e.employeeId);
        const fullEmployees = await EmployeeBasic.find({ employeeId: { $in: employeeIds } })
            .select('employeeId firstName lastName companyEmail personalEmail');

        const recipients = fullEmployees
            .map(emp => emp.companyEmail || emp.personalEmail)
            .filter(email => email);

        if (recipients.length === 0) {
            console.warn('[FineRejectedEmail] No valid email addresses found for employees.');
            return;
        }

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
        if (fine.attachment && fine.attachment.url) {
            try {
                // Validate URL hostname to prevent SSRF
                if (!isValidStorageUrl(fine.attachment.url)) {
                    throw new Error(`Invalid attachment URL: ${fine.attachment.url}`);
                }

                const response = await axios.get(fine.attachment.url, { responseType: 'arraybuffer' });
                attachments.push({
                    filename: fine.attachment.name || `fine_${fine.fineId}_doc.pdf`,
                    content: response.data
                });
                console.log('[FineRejectedEmail] Attachment retrieved successfully.');
            } catch (err) {
                console.error('[FineRejectedEmail] Failed to fetch attachment:', err.message);
            }
        }

        // 4. Email Content
        const subject = `Update regarding Fine Request: #${fine.fineId}`;

        const html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 8px;">
                <h2 style="color: #d32f2f; margin-bottom: 20px;">Fine Request Update</h2>
                
                <p>Dear Employee,</p>
                
                <p>We are writing to inform you that the fine request (ID: <strong>${fine.fineId}</strong>) has been <strong>rejected</strong> by the management.</p>
                
                <div style="background-color: #fce8e6; padding: 15px; border-radius: 6px; margin: 20px 0;">
                    <h3 style="margin-top: 0; color: #c62828;">Status: Rejected</h3>
                    <p><strong>Fine Type:</strong> ${fine.fineType}</p>
                    <p><strong>Category:</strong> ${fine.category}</p>
                    <p><strong>Amount:</strong> ${Number(fine.fineAmount).toLocaleString()} AED</p>
                    ${fine.remarks ? `<p><strong>Remarks:</strong> ${fine.remarks}</p>` : ''}
                </div>

                <p>If you have any questions regarding this decision, please contact the HR department.</p>
                
                <p style="font-size: 12px; color: #999; margin-top: 30px; border-top: 1px solid #eee; padding-top: 10px;">
                    This is an automated message from the VERP System. Please do not reply directly to this email.
                </p>
            </div>
        `;

        // 4. Send Email
        await transporter.sendMail({
            from: `"VERP System" <${process.env.EMAIL_USER}>`,
            to: recipients,
            subject: subject,
            html: html,
            attachments: attachments
        });

        console.log('[FineRejectedEmail] Rejection email sent successfully.');

    } catch (error) {
        console.error('[FineRejectedEmail] Error sending email:', error);
    }
};
