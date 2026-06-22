/**
 * Test: Asset Loss Fine Report acknowledgement (dynamic name + amount in words).
 * Run from VERP_backend: node scripts/sendAssetLossFineAckTestEmail.mjs
 */
import 'dotenv/config';
import nodemailer from 'nodemailer';
import { fillAssetLossFineReportPdfTemplate } from '../utils/fillAssetLossFineReportPdfTemplate.js';
import { buildAssetLossFineAcknowledgementText, amountToWords } from '../utils/buildAssetLossFineEmailFields.js';

const TO = 'razan.docs@gmail.com';
const TEST_NAME = 'alaksha roy mathew annam';
const TEST_AMOUNT = 10125;

const fine = {
    fineId: 'VEGA-FINE-ACK-TEST',
    fineType: 'Loss & Damage',
    category: 'Loss',
    assetId: 'VEGA-ASSET-TEST',
    description: 'Acknowledgement paragraph layout test',
    assetPurchaseDate: '2024-01-15',
    assetPurchaseCost: 15000,
    assetDepreciationAmount: 0,
    serviceCharge: 125,
    totalFineAmount: TEST_AMOUNT,
    fineAmount: TEST_AMOUNT,
    employeeAmount: TEST_AMOUNT,
    responsibleFor: 'Employee',
    payableDuration: 3,
    sourceOfIncome: 'Salary',
    monthStart: '2026-06',
    awardedDate: '2026-06-22',
    assignedEmployees: [
        {
            employeeId: 'ACK-TEST-EMP',
            employeeName: TEST_NAME,
            individualAmount: TEST_AMOUNT,
        },
    ],
};

const assigned = fine.assignedEmployees[0];
const formSummary = { startMonthYear: '06/2026', endMonthYear: '08/2026' };

console.log('Amount in words:', amountToWords(TEST_AMOUNT));
console.log('Acknowledgement preview:\n', buildAssetLossFineAcknowledgementText(TEST_NAME, TEST_AMOUNT));

const pdfBuffer = await fillAssetLossFineReportPdfTemplate({
    fine,
    assigned,
    formSummary,
    employeeName: TEST_NAME,
    hodName: 'Department Manager',
    signatureUrls: {},
});

if (!pdfBuffer?.length) {
    console.error('PDF generation failed');
    process.exit(1);
}

const emailUser = (process.env.EMAIL_USER || process.env.VERP_EMAIL || '').trim();
const emailPass = (process.env.EMAIL_PASS || process.env.VERP_PASS || '').trim();
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

const result = await transporter.sendMail({
    from: `"VeRP System" <${emailUser}>`,
    to: TO,
    subject: `Asset Loss Fine Report — acknowledgement test (${TEST_NAME})`,
    html: `
        <p>Test email for the Asset Loss Fine Report acknowledgement paragraph.</p>
        <p><strong>Employee:</strong> ${TEST_NAME}</p>
        <p><strong>Payable amount:</strong> ${TEST_AMOUNT.toLocaleString()} AED</p>
        <p><strong>Amount in words:</strong> ${amountToWords(TEST_AMOUNT)} DIRHAMS</p>
        <p style="color:#666;font-size:12px;">Automated test from VeRP.</p>
    `,
    attachments: [
        {
            filename: `AssetLossFineReport-ack-test-${TEST_AMOUNT}.pdf`,
            content: pdfBuffer,
            contentType: 'application/pdf',
        },
    ],
});

console.log(`Sent to ${TO}`, result.messageId);
