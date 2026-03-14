import nodemailer from 'nodemailer';
import EmployeeBasic from '../models/EmployeeBasic.js';

/**
 * Sends a notification email to the Accounts department for payment approval.
 * 
 * @param {Object} payment - The created payment object
 * @param {Object} accountsHOD - The Accounts responsible person object
 */
export const sendPaymentApprovalEmail = async (payment, accountsHOD) => {
    try {
        console.log(`[PaymentApprovalEmail] Sending notification for Payment #${payment.paymentId}`);

        const emailUser = process.env.EMAIL_USER;
        const emailPass = process.env.EMAIL_PASS;

        if (!emailUser || !emailPass || !accountsHOD || (!accountsHOD.companyEmail && !accountsHOD.email)) {
            console.warn('[PaymentApprovalEmail] Missing SMTP credentials or recipient email.');
            return;
        }

        const transporter = nodemailer.createTransport({
            host: "smtp.office365.com",
            port: 587,
            secure: false,
            auth: {
                user: emailUser,
                pass: emailPass
            }
        });

        const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/'/g, "");
        const buttonUrl = `${frontendUrl}/Accounts/Payments?paymentId=${payment.paymentId}`;

        const subject = `Payment Pending Approval: ${payment.paymentId} - AED ${parseFloat(payment.amount).toLocaleString()}`;

        const html = `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1e293b; line-height: 1.6; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background-color: #ffffff;">
                <div style="background-color: #0ea5e9; color: white; padding: 30px; text-align: center;">
                    <h1 style="margin: 0; font-size: 24px; letter-spacing: -0.5px;">Payment Approval Required</h1>
                    <p style="margin: 5px 0 0; opacity: 0.9; font-size: 14px;">Verification request for Accounts Department</p>
                </div>
                
                <div style="padding: 40px;">
                    <p style="font-size: 16px;">Hello <strong>${accountsHOD.firstName} ${accountsHOD.lastName}</strong>,</p>
                    
                    <p>A new payment record has been submitted and requires your verification and approval.</p>
                    
                    <div style="background-color: #f8fafc; padding: 25px; border-radius: 12px; border: 1px solid #f1f5f9; margin: 30px 0;">
                        <table style="width: 100%; border-collapse: collapse;">
                            <tr>
                                <td style="padding: 8px 0; font-size: 13px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; width: 140px;">Payment ID:</td>
                                <td style="padding: 8px 0; font-size: 14px; font-weight: 700; color: #0f172a;">${payment.paymentId}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; font-size: 13px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em;">Type:</td>
                                <td style="padding: 8px 0; font-size: 14px; color: #334155; font-weight: 500;">${payment.paymentType}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; font-size: 13px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em;">Paid By:</td>
                                <td style="padding: 8px 0; font-size: 14px; color: #334155; font-weight: 500;">${payment.paidByName}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; font-size: 13px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em;">Amount:</td>
                                <td style="padding: 8px 0; font-size: 18px; color: #0ea5e9; font-weight: 800;">AED ${parseFloat(payment.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; font-size: 13px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em;">Date:</td>
                                <td style="padding: 8px 0; font-size: 14px; color: #334155; font-weight: 500;">${new Date(payment.paymentDate).toLocaleDateString()}</td>
                            </tr>
                        </table>
                    </div>

                    ${payment.description ? `
                    <div style="margin-bottom: 30px;">
                        <p style="font-size: 12px; color: #94a3b8; text-transform: uppercase; font-weight: 700; margin-bottom: 8px;">Remarks / Description:</p>
                        <p style="font-size: 14px; color: #475569; font-style: italic; background-color: #fffbeb; padding: 15px; border-radius: 8px; border-left: 4px solid #fcd34d;">${payment.description}</p>
                    </div>` : ''}

                    <div style="text-align: center; margin-top: 40px;">
                        <a href="${buttonUrl}" 
                           style="background-color: #0ea5e9; color: #ffffff; padding: 16px 36px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block; font-size: 15px; box-shadow: 0 4px 15px rgba(14, 165, 233, 0.3);">
                           Review Payment Details
                        </a>
                    </div>
                </div>
                
                <div style="background-color: #f8fafc; padding: 20px; text-align: center; font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9;">
                    <p style="margin: 0;">This is an automated notification from the VeRP System.</p>
                </div>
            </div>
        `;

        await transporter.sendMail({
            from: `"VeRP Accounts" <${emailUser}>`,
            to: accountsHOD.companyEmail || accountsHOD.email,
            subject: subject,
            html: html
        });

        console.log(`[PaymentApprovalEmail] Email sent successfully to ${accountsHOD.companyEmail || accountsHOD.email}`);
        return true;
    } catch (error) {
        console.error('[PaymentApprovalEmail] Error sending email:', error);
        return false;
    }
};
