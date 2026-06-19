/**
 * One-time: send Asset Loss Fine Report sample PDF to razan.docs@gmail.com
 * Run: node scripts/sendAssetLossFineReportPreviewEmail.mjs
 */
import 'dotenv/config';
import nodemailer from 'nodemailer';
import { fillAssetLossFineReportPdfTemplate } from '../utils/fillAssetLossFineReportPdfTemplate.js';

const TO = 'razan.docs@gmail.com';

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

const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL;
const emailPass = process.env.EMAIL_PASS || process.env.VERP_PASS;
if (!emailUser || !emailPass) {
    console.error('EMAIL_USER / EMAIL_PASS not configured in .env');
    process.exit(1);
}

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.office365.com',
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: false,
    auth: { user: emailUser, pass: emailPass },
});

await transporter.sendMail({
    fromName: 'VeRP System',
    to: TO,
    subject: 'Preview — Asset Loss Fine Report PDF (one-time)',
    html: `
        <p>Hi,</p>
        <p>Please find attached a <strong>one-time preview</strong> of the Asset Loss Fine Report PDF (template fill with sample data).</p>
        <p>Fine reference: <strong>${fine.fineId}</strong></p>
        <p style="color:#666;font-size:12px;">This is an automated test send from VeRP.</p>
    `,
    attachments: [
        {
            filename: `AssetLossFineReport-${fine.fineId}-preview.pdf`,
            content: pdfBuffer,
            contentType: 'application/pdf',
        },
    ],
});

console.log(`Sent preview PDF to ${TO}`);
