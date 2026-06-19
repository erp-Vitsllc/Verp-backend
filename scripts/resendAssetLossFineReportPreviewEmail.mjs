/**
 * Diagnose + resend Asset Loss Fine Report preview to razan.docs@gmail.com
 */
import 'dotenv/config';
import nodemailer from 'nodemailer';
import { setupEmailSubjectTag } from '../utils/setupEmailSubjectTag.js';
import { fillAssetLossFineReportPdfTemplate } from '../utils/fillAssetLossFineReportPdfTemplate.js';

setupEmailSubjectTag();

const TO = 'razan.docs@gmail.com';
const emailUser = (process.env.EMAIL_USER || process.env.VERP_EMAIL || '').trim();
const emailPass = (process.env.EMAIL_PASS || process.env.VERP_PASS || '').trim();

if (!emailUser || !emailPass) {
    console.error('Missing EMAIL_USER or EMAIL_PASS in .env');
    process.exit(1);
}

let smtpHost = (process.env.SMTP_HOST || 'smtp.office365.com').trim();
if (emailUser.includes('@gmail.com')) smtpHost = 'smtp.gmail.com';

console.log('SMTP host:', smtpHost);
console.log('From account:', emailUser.replace(/(.{2}).+(@.+)/, '$1***$2'));

const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: false,
    auth: { user: emailUser, pass: emailPass },
    tls: { ciphers: 'SSLv3' },
});

try {
    await transporter.verify();
    console.log('SMTP verify: OK');
} catch (err) {
    console.error('SMTP verify FAILED:', err?.message || err);
    process.exit(1);
}

const fine = {
    fineId: 'VEGA-Fine-0011',
    fineType: 'Loss & Damage',
    category: 'Loss',
    assetId: 'VEGA-ASSET-0084',
    description: 'ewere3',
    assetPurchaseDate: '2025-06-25',
    serviceCharge: 0,
    totalFineAmount: 200,
    fineAmount: 200,
    responsibleFor: 'Employee',
    payableDuration: 1,
    sourceOfIncome: 'Salary',
    monthStart: '2026-06',
    awardedDate: '2026-06-19',
    assignedEmployees: [{ employeeId: 'PREVIEW', employeeName: 'NESMI NESMI', individualAmount: 200 }],
};

const pdfBuffer = await fillAssetLossFineReportPdfTemplate({
    fine,
    assigned: fine.assignedEmployees[0],
    formSummary: { startMonthYear: '06/2026', endMonthYear: '06/2026' },
    employeeName: 'NESMI NESMI',
    hodName: 'Rafeel Muhmmad',
    signatureUrls: {},
});

const result = await transporter.sendMail({
    from: `"VeRP System" <${emailUser}>`,
    to: TO,
    subject: 'Asset Loss Fine Report — PDF preview (please check spam)',
    html: `
        <div style="font-family:Arial,sans-serif;font-size:14px;color:#333;">
            <p>Hi Razan,</p>
            <p>This is a <strong>test resend</strong> of the Asset Loss Fine Report PDF attachment.</p>
            <p>If you do not see it in Inbox, please check <strong>Spam / Promotions</strong>.</p>
            <p>Fine: <strong>${fine.fineId}</strong></p>
            <p style="font-size:12px;color:#666;">Sent at ${new Date().toISOString()}</p>
        </div>
    `,
    attachments: [
        {
            filename: `AssetLossFineReport-${fine.fineId}-preview.pdf`,
            content: pdfBuffer,
            contentType: 'application/pdf',
        },
    ],
});

console.log('Send result:', {
    messageId: result.messageId,
    accepted: result.accepted,
    rejected: result.rejected,
    response: result.response,
});
