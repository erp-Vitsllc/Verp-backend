import nodemailer from 'nodemailer';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { resolveEmployeeEmail, getFallbackEmailNote } from './resolveEmployeeEmail.js';

/**
 * Sends a notification email to the employee about their payment status (Approved/Rejected).
 * 
 * @param {Object} payment - The payment object
 * @param {string} status - The new status ('Completed' or 'Rejected')
 * @param {string} comment - Optional comments from the approver
 */
export const sendPaymentStatusEmail = async (payment, status, comment = '') => {
    try {
        console.log(`[PaymentStatusEmail] Notifying employee for Payment #${payment.paymentId}`);

        // 1. Fetch Employee Details
        const employeeId = payment.paidBy._id || payment.paidBy;
        const employee = await EmployeeBasic.findById(employeeId)
            .select('firstName lastName companyEmail personalEmail primaryReportee')
            .populate('primaryReportee', 'companyEmail personalEmail');

        if (!employee) {
            console.warn(`[PaymentStatusEmail] Employee not found: ${employeeId}`);
            return;
        }

        const { email: toEmail } = resolveEmployeeEmail(employee);
        if (!toEmail) {
            console.warn(`[PaymentStatusEmail] No email found for employee.`);
            return;
        }

        const isApproved = status === 'Completed' || status === 'Paid';
        const statusText = isApproved ? 'APPROVED & COMPLETED' : 'REJECTED';
        const statusColor = isApproved ? '#10b981' : '#ef4444';
        const icon = isApproved ? '✓' : '✗';

        const subject = `Payment ${isApproved ? 'Approved' : 'Rejected'}: ${payment.paymentId}`;

        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || 'smtp.office365.com',
            port: process.env.SMTP_PORT || 587,
            secure: false,
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });

        const html = `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 20px auto; padding: 0; border: 1px solid #e5e7eb; border-radius: 12px; overflow: hidden; background-color: #ffffff; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
                <div style="background-color: ${statusColor}; color: #ffffff; padding: 30px; text-align: center;">
                    <div style="font-size: 48px; margin-bottom: 10px;">${icon}</div>
                    <h1 style="margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.025em;">Payment ${isApproved ? 'Approved' : 'Rejected'}</h1>
                    <p style="margin: 8px 0 0; opacity: 0.9; font-size: 15px;">Transaction Reference: ${payment.paymentId}</p>
                </div>
                
                <div style="padding: 40px; color: #374151;">
                    <p style="font-size: 16px; line-height: 1.5;">Dear <strong>${employee.firstName} ${employee.lastName}</strong>,</p>
                    
                    <p style="font-size: 15px; line-height: 1.5;">Your payment submission has been reviewed by the Accounts Department.</p>
                    
                    <div style="margin: 30px 0; padding: 20px; background-color: #f9fafb; border-radius: 8px; border-left: 4px solid ${statusColor};">
                        <table style="width: 100%; border-collapse: collapse;">
                            <tr>
                                <td style="padding: 5px 0; color: #6b7280; font-size: 13px; text-transform: uppercase;">Status:</td>
                                <td style="padding: 5px 0; font-weight: 700; color: ${statusColor};">${statusText}</td>
                            </tr>
                            <tr>
                                <td style="padding: 5px 0; color: #6b7280; font-size: 13px; text-transform: uppercase;">Amount:</td>
                                <td style="padding: 5px 0; font-weight: 600;">AED ${parseFloat(payment.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                            </tr>
                            <tr>
                                <td style="padding: 5px 0; color: #6b7280; font-size: 13px; text-transform: uppercase;">Type:</td>
                                <td style="padding: 5px 0; font-weight: 600;">${payment.paymentType}</td>
                            </tr>
                            <tr>
                                <td style="padding: 5px 0; color: #6b7280; font-size: 13px; text-transform: uppercase;">Date:</td>
                                <td style="padding: 5px 0; font-weight: 600;">${new Date(payment.paymentDate).toLocaleDateString()}</td>
                            </tr>
                        </table>
                    </div>

                    ${comment ? `
                    <div style="margin-bottom: 30px;">
                        <h4 style="margin: 0 0 8px 0; font-size: 13px; color: #6b7280; text-transform: uppercase;">Approver's Remarks:</h4>
                        <div style="padding: 15px; background-color: #fffbeb; border: 1px solid #fef3c7; border-radius: 6px; color: #92400e; font-style: italic;">
                            "${comment}"
                        </div>
                    </div>` : ''}

                    <p style="font-size: 14px; color: #6b7280; margin-top: 40px; border-top: 1px solid #f3f4f6; padding-top: 20px;">
                        If you have any questions regarding this transaction, please contact the Accounts Department.
                    </p>
                </div>
                
                <div style="background-color: #f9fafb; padding: 20px; text-align: center; font-size: 12px; color: #9ca3af; border-top: 1px solid #f3f4f6;">
                    Generated by VeRP Digital HR Portal • Automated Notification
                </div>
            </div>
        `;

        await transporter.sendMail({
            from: `"VeRP Accounts" <${process.env.EMAIL_USER}>`,
            to: toEmail,
            subject: subject,
            html: html
        });

        console.log(`[PaymentStatusEmail] Email sent to ${toEmail}`);
    } catch (error) {
        console.error('[PaymentStatusEmail] Error sending email:', error);
    }
};
