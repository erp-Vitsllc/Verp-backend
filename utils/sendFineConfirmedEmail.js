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
export const sendFineConfirmedEmail = async (fine, assignedEmployees) => {
    try {
        console.log(`[FineConfirmedEmail] Preparing email for Fine #${fine.fineId}`);

        // 1. Fetch Employee Emails
        const employeeIds = assignedEmployees.map(e => e.employeeId);
        const fullEmployees = await EmployeeBasic.find({ employeeId: { $in: employeeIds } })
            .select('employeeId firstName lastName companyEmail personalEmail');

        const recipients = fullEmployees
            .map(emp => emp.companyEmail || emp.personalEmail)
            .filter(email => email);

        if (recipients.length === 0) {
            console.warn('[FineConfirmedEmail] No valid email addresses found for employees.');
            return;
        }

        console.log(`[FineConfirmedEmail] Sending to: ${recipients.join(', ')}`);

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
                const urlObj = new URL(fine.attachment.url);
                if (!urlObj.hostname.endsWith('idrivee2.com')) {
                    throw new Error(`Invalid attachment URL hostname: ${urlObj.hostname}`);
                }

                // Fetch the file stream from the URL (S3)
                const response = await axios.get(fine.attachment.url, { responseType: 'arraybuffer' });
                attachments.push({
                    filename: fine.attachment.name || `fine_${fine.fineId}_doc.pdf`,
                    content: response.data
                });
                console.log('[FineConfirmedEmail] Attachment retrieved successfully.');
            } catch (err) {
                console.error('[FineConfirmedEmail] Failed to fetch attachment:', err.message);
                // Proceed without attachment if it fails
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
