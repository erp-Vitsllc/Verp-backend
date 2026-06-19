/**
 * Resend improved preview PDF (no white boxes) with real signatures from DB when available.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import nodemailer from 'nodemailer';
import { connectDB } from '../config/db.js';
import { setupEmailSubjectTag } from '../utils/setupEmailSubjectTag.js';
import { generateAssetLossFineReportPdf } from '../utils/generateAssetLossFineReportPdf.js';
import Fine from '../models/Fine.js';
import { buildFineFormSummary } from '../utils/buildFineFormSummary.js';
import { getDepartmentHOD } from '../utils/getDepartmentHOD.js';

setupEmailSubjectTag();

const TO = 'razan.docs@gmail.com';
const emailUser = (process.env.EMAIL_USER || '').trim();
const emailPass = (process.env.EMAIL_PASS || '').trim();

if (!emailUser || !emailPass) {
    console.error('Missing EMAIL_USER / EMAIL_PASS');
    process.exit(1);
}

await connectDB();

let fine = await Fine.findOne({ fineId: 'VEGA-Fine-0011' }).lean();
if (!fine) {
    fine = {
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
}

const assigned = fine.assignedEmployees?.[0];
const hrHOD = await getDepartmentHOD('hr');
const accountsHOD = await getDepartmentHOD('finance');
const formSummary = await buildFineFormSummary(fine, {
    employeeId: assigned?.employeeId,
    hrHODName: hrHOD ? `${hrHOD.firstName || ''} ${hrHOD.lastName || ''}`.trim() : '',
    accountsHODName: accountsHOD ? `${accountsHOD.firstName || ''} ${accountsHOD.lastName || ''}`.trim() : '',
});

const pdfBuffer = await generateAssetLossFineReportPdf({
    fine,
    assigned,
    formSummary,
    employeeName: assigned?.employeeName || 'NESMI NESMI',
    hodName: formSummary?.employeeStats?.hodName || 'Rafeel Muhmmad',
    hrEmployee: hrHOD,
    accountsEmployee: accountsHOD,
});

if (!pdfBuffer) {
    console.error('PDF generation failed');
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
    subject: 'Asset Loss Fine Report — fixed layout preview',
    html: `<p>Updated PDF preview: no white boxes on table fields, corrected text placement, signatures loaded from employee profiles where available.</p>`,
    attachments: [
        {
            filename: `AssetLossFineReport-${fine.fineId}-fixed.pdf`,
            content: pdfBuffer,
            contentType: 'application/pdf',
        },
    ],
});

console.log('Sent to', TO, result.messageId);
await mongoose.disconnect();
