/**
 * Generate redesigned fine-report PDFs for every fine type and email them to razan.docs@gmail.com.
 * Run from VERP_backend: node scripts/sendAllFineTypeReportPreviewEmail.mjs
 */
import 'dotenv/config';
import nodemailer from 'nodemailer';
import { generatePdfFromHtml, pdfOutputToBuffer } from '../utils/generatePdf.js';
import { buildFineApprovedPdfHtml, FINE_APPROVED_PDF_SELECTOR } from '../utils/buildFineApprovedPdfHtml.js';
import { reportPdfFileName, reportTitleForFine } from '../utils/buildAssetLossFineEmailFields.js';
import { setupEmailSubjectTag } from '../utils/setupEmailSubjectTag.js';

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

const assigned = { employeeId: 'PREVIEW', employeeName: 'NESMI NESMI', individualAmount: 200 };
const formSummary = { startMonthYear: '08/2026', endMonthYear: '09/2026' };

const FINE_TYPES = [
    'Vehicle Fine',
    'Vehicle Damage',
    'Safety Fine',
    'Project Damage',
    'Loss & Damage',
    'Other Fines',
    'Other Damage',
];

function sampleFine(fineType, index) {
    const id = `VEGA-FINE-T${String(index + 1).padStart(2, '0')}`;
    const isLoss = /loss/i.test(fineType);
    return {
        fineId: id,
        fineType,
        category: isLoss ? 'Loss' : 'Fine',
        description: `Sample ${fineType} used to preview the approved report PDF and attachment tab.`,
        serviceCharge: 25,
        discount: 10,
        totalFineAmount: 200,
        fineAmount: 200,
        responsibleFor: 'Employee',
        payableDuration: 2,
        sourceOfIncome: 'Salary',
        monthStart: '2026-08',
        awardedDate: '2026-08-19',
        assignedEmployees: [assigned],
        ...(isLoss
            ? {
                  assetId: 'VEGA-ASSET-0084',
                  assetName: 'Laptop — Demo',
                  assetPurchaseDate: '2025-06-25',
                  assetPurchaseCost: 210,
                  assetDepreciationAmount: 20,
              }
            : {}),
    };
}

async function generateReportPdf(fine) {
    const html = buildFineApprovedPdfHtml({
        fine,
        assigned,
        formSummary,
        employeeName: assigned.employeeName,
        hodName: 'Rafeel Muhmmad',
        signatureUrls: {
            employee: { name: assigned.employeeName },
            hod: { name: 'Rafeel Muhmmad' },
            hr: { name: 'HR Officer' },
            accounts: { name: 'Accounts' },
        },
    });
    const raw = await generatePdfFromHtml(html, FINE_APPROVED_PDF_SELECTOR);
    const buf = pdfOutputToBuffer(raw);
    if (!buf || buf.length < 500) {
        throw new Error(`Empty PDF for ${fine.fineType}`);
    }
    return buf;
}

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

const attachments = [];
for (let i = 0; i < FINE_TYPES.length; i += 1) {
    const fineType = FINE_TYPES[i];
    const fine = sampleFine(fineType, i);
    console.log(`Generating ${reportTitleForFine(fine)}…`);
    const content = await generateReportPdf(fine);
    attachments.push({
        filename: reportPdfFileName(fine),
        content,
        contentType: 'application/pdf',
    });
    console.log(`  ${reportPdfFileName(fine)} (${content.length} bytes)`);
}

const typeList = FINE_TYPES.map((type) => `<li>${type}</li>`).join('');

const result = await transporter.sendMail({
    from: `"VeRP System" <${emailUser}>`,
    to: TO,
    subject: 'Fine report PDFs — generated table UI (matches your layout)',
    html: `
        <div style="font-family:Arial,sans-serif;font-size:14px;color:#333;">
            <p>Hi Razan,</p>
            <p>Please find attached the <strong>generated table-layout</strong> fine reports (header, field cards, deduction table, total payable bar). Title follows the fine type. Discount is an AED amount.</p>
            <ul>${typeList}</ul>
            <p style="font-size:12px;color:#666;">Sent at ${new Date().toISOString()}</p>
        </div>
    `,
    attachments,
});

console.log(`Sent ${attachments.length} PDFs to ${TO} (messageId: ${result.messageId || 'n/a'})`);
