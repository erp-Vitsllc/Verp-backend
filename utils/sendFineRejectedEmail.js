import nodemailer from 'nodemailer';
import EmployeeBasic from '../models/EmployeeBasic.js';
import User from '../models/User.js';
import axios from 'axios';
import { resolveEmployeeEmail, addEmployeeEmailToSet } from './resolveEmployeeEmail.js';

/**
 * Sends a rejection email to assigned employees when a fine is rejected by CEO/Admin.
 * 
 * @param {Object} fine - The full fine object
 * @param {Array} assignedEmployees - Array of assigned employee objects from the fine
 */
export const sendFineRejectedEmail = async (fine, assignedEmployees) => {
    try {
        console.log(`[FineRejectedEmail] Preparing rejection email for Fine #${fine.fineId}`);

        // 1. Fetch Employee Emails and their Managers
        const employeeIds = assignedEmployees.map(e => e.employeeId);

        // 1b. Fetch Previous Approver Emails from Workflow
        const previousApproverIds = (fine.workflow || [])
            .filter(w => w.status === 'Approved' && w.assignedTo)
            .map(w => w.assignedTo);

        // 1c. Fetch Creator (User)
        const creatorId = fine.createdBy;

        const [fullEmployees, previousApproverUsers, creatorUser] = await Promise.all([
            EmployeeBasic.find({ employeeId: { $in: employeeIds } })
                .select('employeeId firstName lastName companyEmail personalEmail primaryReportee')
                .populate('primaryReportee', 'companyEmail workEmail'),
            User.find({ _id: { $in: previousApproverIds } })
                .select('email companyEmail'),
            creatorId ? User.findById(creatorId).select('email companyEmail') : null
        ]);

        const recipientEmails = new Set();

        // Add Target Employees (fallback to primaryReportee when emp has no email)
        fullEmployees.forEach(emp => {
            const { email } = resolveEmployeeEmail(emp);
            if (email) recipientEmails.add(email);

            addEmployeeEmailToSet(recipientEmails, emp.primaryReportee);
        });

        // Add Previous Approvers
        previousApproverUsers.forEach(u => {
            const mail = (u.companyEmail || '').trim();
            if (mail) recipientEmails.add(mail);
        });

        if (creatorUser?.companyEmail) {
            const creatorMail = String(creatorUser.companyEmail).trim();
            if (creatorMail) recipientEmails.add(creatorMail);
        }

        const recipients = Array.from(recipientEmails);

        if (recipients.length === 0) {
            console.warn('[FineRejectedEmail] No valid email addresses found for employees or previous approvers.');
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
                const rawUrl = String(fine.attachment.url);

                // INLINE VALIDATION FOR SNYK (Explicit check right before use)
                const isSafe = /^https:\/\/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.idrivee2\.com\/[^\s<>]+$/i.test(rawUrl);

                if (!isSafe || rawUrl.includes('localhost') || rawUrl.includes('127.0.0.1')) {
                    throw new Error(`SSRF Blocked: Invalid attachment URL signature: ${rawUrl}`);
                }

                const response = await axios.get(rawUrl, {
                    responseType: 'arraybuffer',
                    timeout: 5000,           // 5 seconds timeout
                    maxContentLength: 5242880 // 5MB limit
                });

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
        const isGroup = assignedEmployees.length > 1;
        const subject = isGroup 
            ? `Update regarding Group Fine Request: #${fine.fineId}`
            : `Update regarding Fine Request: #${fine.fineId}`;

        // Prepare dynamic employees list table
        let employeesTable = '';
        if (isGroup) {
            const rows = assignedEmployees.map(e => `
                <tr>
                    <td style="border: 1px solid #ddd; padding: 8px;">${e.employeeName || e.employeeId}</td>
                    <td style="border: 1px solid #ddd; padding: 8px;">${e.employeeId}</td>
                    <td style="border: 1px solid #ddd; padding: 8px;">${Number(e.amount).toLocaleString()} AED</td>
                </tr>
            `).join('');

            employeesTable = `
                <div style="margin-top: 20px;">
                    <p><strong>Employees Included in this Group Fine:</strong></p>
                    <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                        <thead>
                            <tr style="background-color: #f8f9fa;">
                                <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Name</th>
                                <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">ID</th>
                                <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Share</th>
                            </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            `;
        }

        const html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 8px;">
                <h2 style="color: #d32f2f; margin-bottom: 20px;">Fine Request Update${isGroup ? ' (Group Request)' : ''}</h2>
                
                <p>Dear Employee,</p>
                
                <p>We are writing to inform you that the fine request (ID: <strong>${fine.fineId}</strong>) has been <strong>rejected</strong> by the management.</p>
                
                <div style="background-color: #fce8e6; padding: 15px; border-radius: 6px; margin: 20px 0;">
                    <h3 style="margin-top: 0; color: #c62828;">Status: Rejected</h3>
                    <p><strong>Fine Type:</strong> ${fine.fineType}</p>
                    <p><strong>Category:</strong> ${fine.category}</p>
                    <p><strong>Amount:</strong> ${Number(fine.fineAmount).toLocaleString()} AED</p>
                    ${fine.rejectionReason ? `<p><strong>Reason for Rejection:</strong> ${fine.rejectionReason}</p>` : ''}
                    ${fine.remarks ? `<p><strong>Remarks:</strong> ${fine.remarks}</p>` : ''}
                    
                    ${employeesTable}
                </div>

                <p>If you have any questions regarding this decision, please contact the HR department.</p>
                
                <p style="font-size: 12px; color: #999; margin-top: 30px; border-top: 1px solid #eee; padding-top: 10px;">
                    This is an automated message from the VERP System. Please do not reply directly to this email.
                </p>
            </div>
        `;

        // 4. Send Email
        await transporter.sendMail({
            fromName: "HR Department",
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
