import nodemailer from 'nodemailer';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { resolveEmployeeEmail, getFallbackEmailNote } from './resolveEmployeeEmail.js';

/**
 * Sends a neat invoice email after a payment is made.
 * 
 * @param {Object} payment - The full payment object
 * @param {Object} relatedEntity - The related Fine or Loan object (optional)
 */
export const sendPaymentInvoiceEmail = async (payment, relatedEntity = null) => {
    try {
        console.log(`[PaymentInvoiceEmail] Preparing invoice for Payment #${payment.paymentId}`);

        // 1. Fetch Employee Details and their Primary Reportee
        const employeeId = payment.paidBy._id || payment.paidBy;
        const employee = await EmployeeBasic.findById(employeeId)
            .select('employeeId firstName lastName companyEmail personalEmail primaryReportee')
            .populate('primaryReportee', 'firstName lastName companyEmail personalEmail');

        if (!employee) {
            console.error(`[PaymentInvoiceEmail] Employee not found: ${employeeId}`);
            return;
        }

        const toEmails = new Set();
        const ccEmails = new Set();

        // Applicant (Employee who paid) - fallback to primaryReportee when emp has no email
        const { email: employeeEmail, isFallbackToReportee, employeeName, reporteeName } = resolveEmployeeEmail(employee);
        if (employeeEmail) {
            toEmails.add(employeeEmail);
        }

        // Primary Reportee (Supervisor/Manager) - only add if not already in toEmails (from fallback)
        if (employee.primaryReportee) {
            const reporteeEmail = employee.primaryReportee.companyEmail || employee.primaryReportee.personalEmail;
            if (reporteeEmail && !toEmails.has(reporteeEmail)) {
                ccEmails.add(reporteeEmail);
            }
        }

        if (toEmails.size === 0) {
            console.warn(`[PaymentInvoiceEmail] No recipient email found for employee: ${employee.employeeId}`);
            return;
        }

        // 2. Prepare Data for Invoice
        const type = payment.paymentType;
        const id = payment.paymentId;
        const refId = payment.referenceId || payment.relatedEntityId || 'N/A';
        const date = new Date(payment.paymentDate).toLocaleDateString('en-GB', {
            day: '2-digit',
            month: 'long',
            year: 'numeric'
        });
        const amountPaid = parseFloat(payment.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const description = payment.description || payment.remarks || 'No description provided';
        
        let totalAmount = 0;
        let totalPaidSoFar = 0;
        let remainingBalance = 0;
        let duration = 'N/A';
        let monthStart = 'N/A';

        if (relatedEntity) {
            if (payment.relatedEntityType === 'Fine') {
                totalAmount = parseFloat(relatedEntity.employeeAmount || relatedEntity.fineAmount || 0);
                totalPaidSoFar = parseFloat(relatedEntity.paidAmount || 0);
                remainingBalance = Math.max(0, totalAmount - totalPaidSoFar);
                duration = relatedEntity.payableDuration ? `${relatedEntity.payableDuration} Month(s)` : 'N/A';
                monthStart = relatedEntity.monthStart || 'N/A';
            } else if (payment.relatedEntityType === 'Loan') {
                totalAmount = parseFloat(relatedEntity.amount || 0);
                totalPaidSoFar = parseFloat(relatedEntity.paidAmount || 0);
                remainingBalance = Math.max(0, totalAmount - totalPaidSoFar);
                duration = relatedEntity.duration ? `${relatedEntity.duration} Month(s)` : 'N/A';
                monthStart = relatedEntity.monthStart || 'N/A';
            }
        }

        const formattedTotalAmount = totalAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const formattedTotalPaid = totalPaidSoFar.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const formattedRemaining = remainingBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        
        // Calculate installment (simple approximation)
        let installmentInfo = '';
        if (remainingBalance > 0 && relatedEntity) {
            const durationVal = payment.relatedEntityType === 'Fine' ? relatedEntity.payableDuration : relatedEntity.duration;
            if (durationVal > 1) {
                const estInstallment = (totalAmount / durationVal).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                installmentInfo = `Estimated Monthly Installment: <strong>${estInstallment} AED</strong>`;
            }
        }

        // 3. Transporter Setup
        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || 'smtp.office365.com',
            port: process.env.SMTP_PORT || 587,
            secure: false,
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });

        const subject = `Payment Invoice: ${id} (${type})`;

        // 4. HTML Template
        const html = `
            <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: 20px auto; padding: 40px; border: 1px solid #e0e0e0; border-radius: 8px; color: #444; background-color: #ffffff; box-shadow: 0 4px 10px rgba(0,0,0,0.05);">
                <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 40px; border-bottom: 2px solid #0056b3; padding-bottom: 20px;">
                    <div>
                        <h1 style="color: #0056b3; margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">INVOICE</h1>
                        <p style="color: #666; margin: 4px 0 0 0; font-size: 14px;">Reference: <strong>${id}</strong></p>
                    </div>
                    <div style="text-align: right;">
                        <h2 style="color: #333; margin: 0; font-size: 18px; font-weight: 700;">VERP</h2>
                        <p style="color: #999; margin: 4px 0 0 0; font-size: 12px;">Digital Payment Confirmation</p>
                    </div>
                </div>

                <div style="margin-bottom: 40px;">
                    <table style="width: 100%;">
                        <tr>
                            <td style="width: 50%; vertical-align: top;">
                                <p style="margin: 0 0 8px 0; color: #999; font-size: 12px; text-transform: uppercase; font-weight: bold;">Bill To</p>
                                <p style="margin: 0; font-size: 16px; font-weight: 700;">${employee.firstName} ${employee.lastName}</p>
                                <p style="margin: 4px 0 0 0; font-size: 14px; color: #666;">Employee ID: ${employee.employeeId}</p>
                                <p style="margin: 2px 0 0 0; font-size: 14px; color: #666;">${employee.companyEmail || employee.personalEmail || ''}</p>
                            </td>
                            <td style="width: 50%; vertical-align: top; text-align: right;">
                                <p style="margin: 0 0 8px 0; color: #999; font-size: 12px; text-transform: uppercase; font-weight: bold;">Details</p>
                                <p style="margin: 0; font-size: 14px; color: #666;">Date: <strong>${date}</strong></p>
                                <p style="margin: 4px 0 0 0; font-size: 14px; color: #666;">Ref Type: <strong>${type}</strong></p>
                                <p style="margin: 4px 0 0 0; font-size: 14px; color: #666;">Ref ID: <strong>${refId}</strong></p>
                            </td>
                        </tr>
                    </table>
                </div>

                <div style="margin-bottom: 40px;">
                    <table style="width: 100%; border-collapse: collapse;">
                        <thead>
                            <tr style="background-color: #f8f9fa;">
                                <th style="padding: 12px 15px; text-align: left; border-bottom: 1px solid #dee2e6; color: #666; font-size: 13px;">Item Description</th>
                                <th style="padding: 12px 15px; text-align: right; border-bottom: 1px solid #dee2e6; color: #666; font-size: 13px;">Details</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td style="padding: 15px; border-bottom: 1px solid #f1f1f1; vertical-align: top;">
                                    <p style="margin: 0; font-weight: bold; font-size: 15px;">${type} Payment</p>
                                    <p style="margin: 8px 0 0 0; font-size: 13px; color: #777; line-height: 1.5;">${description}</p>
                                </td>
                                <td style="padding: 15px; border-bottom: 1px solid #f1f1f1; text-align: right; vertical-align: top;">
                                    <p style="margin: 0; font-size: 14px;">Applied Month: <strong>${monthStart}</strong></p>
                                    <p style="margin: 5px 0 0 0; font-size: 14px;">Plan Duration: <strong>${duration}</strong></p>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <div style="display: flex; justify-content: flex-end;">
                    <div style="width: 100%; max-width: 300px; margin-left: auto;">
                        <table style="width: 100%; border-collapse: collapse;">
                            <tr>
                                <td style="padding: 8px 0; color: #777; font-size: 14px;">Total Amount:</td>
                                <td style="padding: 8px 0; text-align: right; font-weight: 600;">${formattedTotalAmount} AED</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #777; font-size: 14px;">Paid Earlier:</td>
                                <td style="padding: 8px 0; text-align: right; font-weight: 600;">${(totalPaidSoFar - payment.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} AED</td>
                            </tr>
                            <tr style="border-top: 1px solid #eee; border-bottom: 2px solid #0056b3;">
                                <td style="padding: 15px 0; color: #333; font-weight: 700; font-size: 15px;">PAID NOW:</td>
                                <td style="padding: 15px 0; text-align: right; color: #0056b3; font-weight: 800; font-size: 20px;">${amountPaid} AED</td>
                            </tr>
                            <tr>
                                <td style="padding: 15px 0; color: #dc3545; font-weight: 700; font-size: 14px;">BALANCE:</td>
                                <td style="padding: 15px 0; text-align: right; color: #dc3545; font-weight: 800; font-size: 18px;">${formattedRemaining} AED</td>
                            </tr>
                        </table>
                    </div>
                </div>

                <div style="margin-top: 40px; padding: 20px; background-color: #f1f8ff; border-radius: 6px; border-left: 4px solid #0056b3;">
                    <p style="margin: 0; font-size: 14px; color: #004085; line-height: 1.6;">
                        <strong>Note:</strong> ${employee.firstName} ${employee.lastName} has successfully paid <strong>${amountPaid} AED</strong>. 
                        ${remainingBalance > 0 ? `The current outstanding balance is <strong>${formattedRemaining} AED</strong>. ${installmentInfo}` : 'This account is now fully settled. Thank you for the payment!'}
                    </p>
                </div>

                <div style="margin-top: 40px; text-align: center; border-top: 1px solid #eee; padding-top: 20px;">
                    <p style="margin: 0; font-size: 11px; color: #aaa; text-transform: uppercase; letter-spacing: 1px;">Generated by VERP System • Automated Information Only</p>
                </div>
            </div>
        `;
        await transporter.sendMail({
            from: `"VERP System" <${process.env.EMAIL_USER}>`,
            to: Array.from(toEmails).join(','),
            cc: Array.from(ccEmails).join(','),
            subject: subject,
            html: html
        });

        console.log(`[PaymentInvoiceEmail] Invoice sent to ${Array.from(toEmails).join(',')}`);

    } catch (error) {
        console.error('[PaymentInvoiceEmail] Error sending email:', error);
    }
};
