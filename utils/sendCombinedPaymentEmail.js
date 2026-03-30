import nodemailer from 'nodemailer';
import puppeteer from 'puppeteer';
import EmployeeBasic from '../models/EmployeeBasic.js';
import Fine from '../models/Fine.js';
import Loan from '../models/Loan.js';
import Payment from '../models/Payment.js';

// Payment recipient rule:
// 1) companyEmail (preferred)
// 2) personalEmail fallback
// 3) workEmail/email as last resort
const resolvePaymentRecipientEmail = (employee) => {
    const isUsableEmail = (value) => {
        const v = String(value || '').trim().toLowerCase();
        if (!v) return false;
        if (v === 'n/a@company.com' || v === 'na@company.com') return false;
        if (v === 'n/a' || v === 'na' || v === '-') return false;
        return true;
    };

    if (!employee) return null;
    const company = (employee.companyEmail || '').trim();
    if (isUsableEmail(company)) return company;
    const personal = (employee.personalEmail || '').trim();
    if (isUsableEmail(personal)) return personal;
    const work = (employee.workEmail || '').trim();
    if (isUsableEmail(work)) return work;
    const email = (employee.email || '').trim();
    if (isUsableEmail(email)) return email;
    return null;
};

/**
 * Calculates the share for a specific employee in a fine.
 */
const calculateEmployeeShare = (fine, targetEmployeeId) => {
    if (!fine) return 0;

    // 1. SPECIFIC EMPLOYEE RECORD PRIORITY
    if (targetEmployeeId && fine.assignedEmployees?.length > 0) {
        const record = fine.assignedEmployees.find(e => e.employeeId === targetEmployeeId);
        if (record && record.individualAmount > 0) {
            return parseFloat(record.individualAmount);
        }
    }

    const isCompany = (fine.responsibleFor || '').toLowerCase() === 'company';
    if (isCompany) return 0;

    const realEmployees = (fine.assignedEmployees || []).filter(emp => 
        emp.employeeId !== 'VEGA-HR-0000' && 
        emp.employeeId !== 'VEGA_INTERNAL' &&
        emp.employeeName !== 'Vega Digital IT Solutions'
    );
    
    const companyAmount = parseFloat(fine.companyAmount || 0);
    const fineAmount = parseFloat(fine.fineAmount || 0);
    const employeeAmount = parseFloat(fine.employeeAmount || 0);
    
    if (realEmployees.length === 1 && companyAmount === 0) return fineAmount;
    if (employeeAmount > 0 && employeeAmount <= fineAmount && realEmployees.length > 1) return employeeAmount / realEmployees.length;
    if (realEmployees.length === 1 && employeeAmount > 0 && employeeAmount <= fineAmount) return employeeAmount;
    
    const calculatedEmpAmount = fineAmount - companyAmount;
    return realEmployees.length > 0 ? calculatedEmpAmount / realEmployees.length : calculatedEmpAmount;
};

const SUCCESS_STATUSES = ['Completed', 'Paid', 'Success', 'Approved', 'Active'];

const computeHistoricalPaidForEmployee = ({ payments, currentPayment }) => {
    const currentRefTime = new Date(
        currentPayment.paymentDate || currentPayment.createdAt || new Date()
    ).getTime();
    const currentId = (currentPayment._id || currentPayment.paymentId || '').toString();
    const paidNow = parseFloat(currentPayment.amount || 0);

    const historical = (payments || []).filter((p) => {
        const pStatus = String(p.status || p.approvalStatus || '').toLowerCase();
        const isOk = SUCCESS_STATUSES.map((s) => s.toLowerCase()).includes(pStatus);
        if (!isOk) return false;

        const pTime = new Date(p.paymentDate || p.createdAt || 0).getTime();
        if (pTime < currentRefTime) return true;
        if (pTime === currentRefTime) {
            const pId = (p._id || p.paymentId || '').toString();
            return pId === currentId;
        }
        return false;
    });

    const totalPaidAtTime = historical.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
    const paidEarlierAtTime = Math.max(0, totalPaidAtTime - paidNow);
    return { totalPaidAtTime, paidEarlierAtTime };
};

/**
 * Generates a PDF Buffer of the invoice.
 */
const generateInvoicePDF = async (data) => {
    const { 
        payment, employee, currentShare, paidEarlier, paidNow, balance, totalRemainingAll, otherDebts, currentItem, recipientEmail
    } = data;

    const browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    const page = await browser.newPage();

    const htmlContent = `
    <html>
    <head>
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #333; margin: 0; padding: 40px; }
            .invoice-container { max-width: 800px; margin: auto; border: 1px solid #eee; padding: 30px; border-radius: 8px; box-shadow: 0 0 10px rgba(0,0,0,0.05); }
            .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #0056b3; padding-bottom: 20px; margin-bottom: 30px; }
            .header h1 { color: #0056b3; margin: 0; font-size: 28px; font-weight: 800; }
            .header .company { text-align: right; }
            .header .company h2 { color: #333; margin: 0; font-size: 18px; }
            .header .company p { color: #777; margin: 5px 0 0; font-size: 11px; }

            .bill-section { display: flex; justify-content: space-between; margin-bottom: 40px; }
            .bill-section h3 { font-size: 12px; color: #999; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px; }
            .bill-section p { margin: 3px 0; font-size: 14px; }
            .bill-section .val { font-weight: 600; }

            .items-table { width: 100%; border-collapse: collapse; margin-bottom: 30px; }
            .items-table th { background: #f8f9fa; text-align: left; padding: 12px; font-size: 12px; color: #666; text-transform: uppercase; border-bottom: 1px solid #eee; }
            .items-table td { padding: 15px 12px; border-bottom: 1px solid #f1f1f1; font-size: 14px; vertical-align: top; }
            .item-desc { font-weight: 700; color: #333; margin-bottom: 4px; }
            .item-sub { font-size: 12px; color: #777; }

            .summary-section { display: flex; justify-content: flex-end; }
            .summary-table { width: 300px; }
            .summary-table tr td { padding: 8px 0; font-size: 14px; }
            .summary-table tr td:last-child { text-align: right; font-weight: 600; }
            .summary-table .paid-now { color: #0056b3; font-size: 18px; font-weight: 800; border-top: 1px solid #eee; border-bottom: 2px solid #0056b3; padding: 15px 0; }
            .summary-table .balance { color: #e63946; font-size: 16px; font-weight: 700; padding-top: 15px; }

            .note-box { background: #f0f7ff; border-left: 4px solid #0056b3; padding: 15px; margin-top: 40px; border-radius: 4px; }
            .note-box p { margin: 0; font-size: 13px; line-height: 1.6; color: #2c5282; font-weight: 500; }

            .footer { text-align: center; margin-top: 50px; color: #aaa; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; border-top: 1px solid #eee; padding-top: 20px; }
        </style>
    </head>
    <body>
        <div class="invoice-container">
            <div class="header">
                <div>
                    <h1>INVOICE</h1>
                    <p style="margin: 5px 0; color: #777; font-size: 13px;">Reference: <strong>${payment.paymentId}</strong></p>
                </div>
                <div class="company">
                    <h2>VERP</h2>
                    <p>Digital Payment Confirmation</p>
                </div>
            </div>

            <div class="bill-section">
                <div>
                    <h3>Bill To</h3>
                    <p class="val">${employee.firstName} ${employee.lastName}</p>
                    <p>Employee ID: ${employee.employeeId}</p>
                    <p style="color: #0056b3; text-decoration: underline;">${recipientEmail || ''}</p>
                </div>
                <div style="text-align: right;">
                    <h3>Details</h3>
                    <p>Date: <span class="val">${new Date(payment.paymentDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</span></p>
                    <p>Ref Type: <span class="val">${payment.paymentType}</span></p>
                    <p>Ref ID: <span class="val">${payment.referenceId || 'N/A'}</span></p>
                </div>
            </div>

            <table class="items-table">
                <thead>
                    <tr>
                        <th style="width: 70%;">Item Description</th>
                        <th style="text-align: right;">Details</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td>
                            <div class="item-desc">${payment.paymentType} Payment</div>
                            <div class="item-sub">Payment for ${payment.referenceId || 'N/A'}</div>
                        </td>
                        <td style="text-align: right; font-size: 12px; color: #555;">
                            Applied Month: <strong>${currentItem?.monthStart || 'N/A'}</strong><br/>
                            Plan Duration: <strong>${(payment.relatedEntityType === 'Fine' ? currentItem?.payableDuration : currentItem?.duration) || 1} Month(s)</strong>
                        </td>
                    </tr>
                </tbody>
            </table>

            <div class="summary-section">
                <table class="summary-table">
                    <tr>
                        <td style="color: #999;">Total Amount:</td>
                        <td>${currentShare.toLocaleString(undefined, { minimumFractionDigits: 2 })} AED</td>
                    </tr>
                    <tr>
                        <td style="color: #999;">Paid Earlier:</td>
                        <td>${paidEarlier.toLocaleString(undefined, { minimumFractionDigits: 2 })} AED</td>
                    </tr>
                    <tr class="paid-now">
                        <td>PAID NOW:</td>
                        <td>${paidNow.toLocaleString(undefined, { minimumFractionDigits: 2 })} AED</td>
                    </tr>
                    <tr class="balance">
                        <td>BALANCE:</td>
                        <td>${balance.toLocaleString(undefined, { minimumFractionDigits: 2 })} AED</td>
                    </tr>
                </table>
            </div>

            <div class="note-box">
                <p>
                    <strong>Note:</strong> ${employee.firstName} ${employee.lastName} has successfully paid <strong>${paidNow.toLocaleString(undefined, { minimumFractionDigits: 2 })} AED</strong>. 
                    The current outstanding balance for this item is <strong>${balance.toLocaleString(undefined, { minimumFractionDigits: 2 })} AED</strong>.
                    ${(payment.relatedEntityType === 'Fine' ? (currentItem?.payableDuration > 1) : (currentItem?.duration > 1)) ? `Estimated Monthly Installment: <strong>${(currentShare / (payment.relatedEntityType === 'Fine' ? currentItem.payableDuration : currentItem.duration)).toLocaleString(undefined, { minimumFractionDigits: 2 })} AED</strong>` : ''}
                </p>
            </div>

            ${totalRemainingAll > balance ? `
            <div style="margin-top: 20px; padding: 15px; border: 1px dashed #cbd5e0; border-radius: 8px;">
                <h4 style="margin: 0 0 10px 0; font-size: 12px; color: #4a5568; text-transform: uppercase;">Total Financial Liability</h4>
                <p style="margin: 0; font-size: 14px; font-weight: 700; color: #2d3748;">
                    Total Outstanding Balance (All Items): <span style="color: #e53e3e;">${totalRemainingAll.toLocaleString(undefined, { minimumFractionDigits: 2 })} AED</span>
                </p>
                <div style="margin-top: 10px; display: grid; grid-template-cols: 1fr 1fr; gap: 5px;">
                    ${otherDebts.map(d => `
                        <div style="font-size: 11px; color: #718096;">• ${d.type} (${d.id}): <strong>${d.balance.toLocaleString()} AED</strong></div>
                    `).join('')}
                </div>
            </div>` : ''}

            <div class="footer">
                Generated by VeRP System • Automated Information Only
            </div>
        </div>
    </body>
    </html>
    `;

    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '0', right: '0', bottom: '0', left: '0' }
    });

    await browser.close();
    return pdfBuffer;
};

/**
 * Sends a combined status and invoice email to the employee.
 */
export const sendPaymentNotificationEmail = async (payment, status, comment = '') => {
    try {
        const isApproved = status === 'Completed' || status === 'Paid';
        const employeeId = payment.paidBy._id || payment.paidBy;
        
        const employee = await EmployeeBasic.findById(employeeId)
            .select('employeeId firstName lastName companyEmail personalEmail workEmail email primaryReportee')
            .populate('primaryReportee', 'firstName lastName companyEmail personalEmail');

        if (!employee) return;

        const toEmail = resolvePaymentRecipientEmail(employee);
        if (!toEmail) return;

        // FETCH OUTSTANDING DEBTS
        const otherDebts = [];
        let totalRemainingAll = 0;

        // 1. All Fines
        const fines = await Fine.find({ 
            "assignedEmployees.employeeId": employee.employeeId,
            fineStatus: { $nin: ['Paid', 'Cancelled', 'Rejected'] }
        });
        
        for (const f of fines) {
            const share = calculateEmployeeShare(f, employee.employeeId);
            const remaining = Math.max(0, share - (f.paidAmount || 0));
            if (remaining > 0.01) {
                totalRemainingAll += remaining;
                if (payment.relatedEntityId?.toString() !== f._id.toString() && payment.referenceId !== f.fineId) {
                    otherDebts.push({ type: 'Fine', id: f.fineId, balance: remaining });
                }
            }
        }

        // 2. All Loans/Advances
        const loans = await Loan.find({
            employeeId: employee.employeeId,
            status: { $nin: ['Paid', 'Cancelled', 'Rejected'] }
        });

        for (const l of loans) {
            const remaining = Math.max(0, (l.amount || 0) - (l.paidAmount || 0));
            if (remaining > 0.01) {
                totalRemainingAll += remaining;
                if (payment.relatedEntityId?.toString() !== l._id.toString() && payment.referenceId !== l.loanId) {
                    otherDebts.push({ type: l.type, id: l.loanId || 'N/A', balance: remaining });
                }
            }
        }

        const statusColor = isApproved ? '#10b981' : '#ef4444';
        const statusText = isApproved ? 'Success' : 'Rejected';
        const subject = `Payment ${statusText}: ${payment.paymentId}`;

        let currentShare = 0;
        let paidEarlier = 0;
        let balance = 0;
        let currentItem = null;
        let pdfBuffer = null;

        if (isApproved) {
            let itemPayments = [];
            if (payment.relatedEntityType === 'Fine') {
                currentItem = await Fine.findById(payment.relatedEntityId) || await Fine.findOne({ fineId: payment.referenceId });
                currentShare = calculateEmployeeShare(currentItem, employee.employeeId);
                if (currentItem) {
                    itemPayments = await Payment.find({
                        relatedEntityType: 'Fine',
                        paidBy: employee._id,
                        status: { $in: SUCCESS_STATUSES },
                        $or: [{ relatedEntityId: currentItem._id }, { referenceId: currentItem.fineId }]
                    }).lean();
                }
            } else if (payment.relatedEntityType === 'Loan') {
                currentItem = await Loan.findById(payment.relatedEntityId) || await Loan.findOne({ loanId: payment.referenceId });
                currentShare = currentItem?.amount || 0;
                if (currentItem) {
                    itemPayments = await Payment.find({
                        relatedEntityType: 'Loan',
                        paidBy: employee._id,
                        status: { $in: SUCCESS_STATUSES },
                        $or: [{ relatedEntityId: currentItem._id }, { referenceId: currentItem.loanId }]
                    }).lean();
                }
            }

            const paidNow = parseFloat(payment.amount || 0);
            const { totalPaidAtTime, paidEarlierAtTime } = computeHistoricalPaidForEmployee({
                payments: itemPayments,
                currentPayment: payment
            });
            paidEarlier = paidEarlierAtTime;
            balance = Math.max(0, currentShare - totalPaidAtTime);

            // Generate PDF
            try {
                pdfBuffer = await generateInvoicePDF({
                    payment, employee, currentShare, paidEarlier, paidNow, balance, totalRemainingAll, otherDebts, currentItem, recipientEmail: toEmail
                });
            } catch (pdfErr) {
                console.error('[PaymentNotification] PDF Gen Error:', pdfErr);
            }
        }

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
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 20px auto; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden; background-color: #ffffff;">
                <div style="background-color: ${statusColor}; color: #ffffff; padding: 40px 20px; text-align: center;">
                    <h1 style="margin: 0; font-size: 28px; font-weight: 800;">Payment ${statusText}</h1>
                    <p style="margin: 10px 0 0; opacity: 0.9;">Ref: ${payment.paymentId}</p>
                </div>

                <div style="padding: 40px; color: #1e293b;">
                    <p>Dear <strong>${employee.firstName} ${employee.lastName}</strong>,</p>
                    <p style="line-height: 1.6; color: #475569;">
                        ${isApproved 
                            ? `Your payment of <strong>AED ${parseFloat(payment.amount).toLocaleString()}</strong> has been successfully processed. Please find your invoice attached to this email.`
                            : `Your payment request for <strong>AED ${parseFloat(payment.amount).toLocaleString()}</strong> has been rejected by the Accounts Department.`
                        }
                    </p>

                    ${comment ? `
                    <div style="margin: 20px 0; padding: 15px; background-color: #fef2f2; border-left: 4px solid #ef4444;">
                        <span style="font-size: 11px; font-weight: 700; color: #991b1b;">REMARK:</span>
                        <p style="margin: 5px 0 0; font-style: italic;">"${comment}"</p>
                    </div>` : ''}

                    ${isApproved ? `
                    <div style="margin-top: 30px; padding: 20px; background-color: #f8fafc; border-radius: 12px; border: 1px solid #e2e8f0;">
                        <h3 style="margin: 0 0 15px; font-size: 14px; color: #1e293b;">Financial Snapshot</h3>
                        <div style="display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 13px;">
                            <span style="color: #64748b;">Paid Now:</span>
                            <span style="font-weight: 700;">AED ${parseFloat(payment.amount).toLocaleString()}</span>
                        </div>
                        <div style="display: flex; justify-content: space-between; font-size: 13px;">
                            <span style="color: #64748b;">Total Remaining (All Items):</span>
                            <span style="font-weight: 700; color: #ef4444;">AED ${totalRemainingAll.toLocaleString()}</span>
                        </div>
                    </div>` : ''}

                    <p style="margin-top: 40px; font-size: 12px; color: #94a3b8; text-align: center;">
                        VeRP Digital • Automated Financial Service
                    </p>
                </div>
            </div>
        `;

        const mailOptions = {
            from: `"VeRP Accounts" <${process.env.EMAIL_USER}>`,
            to: toEmail,
            subject: subject,
            html: html,
            attachments: pdfBuffer ? [{
                filename: `Invoice_${payment.paymentId}.pdf`,
                content: pdfBuffer,
                contentType: 'application/pdf'
            }] : []
        };

        await transporter.sendMail(mailOptions);
        console.log(`[PaymentNotification] Email with PDF sent to ${toEmail}`);

    } catch (error) {
        console.error('[PaymentNotification] Error:', error);
    }
};
