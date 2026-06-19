import 'dotenv/config';
import fs from 'fs';
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import Fine from '../models/Fine.js';
import { generateAssetLossFineReportPdf } from '../utils/generateAssetLossFineReportPdf.js';
import { buildFineFormSummary } from '../utils/buildFineFormSummary.js';
import { getDepartmentHOD } from '../utils/getDepartmentHOD.js';

await connectDB();
const fine = await Fine.findOne({ fineId: 'VEGA-FINE-0013' }).lean();
const assigned = fine.assignedEmployees[0];
const hrHOD = await getDepartmentHOD('hr');
const accountsHOD = await getDepartmentHOD('finance');
const formSummary = await buildFineFormSummary(fine, { employeeId: assigned.employeeId });

const pdf = await generateAssetLossFineReportPdf({
    fine,
    assigned,
    formSummary,
    employeeName: assigned.employeeName,
    hodName: 'Raseel Muhmmad',
    hrEmployee: hrHOD,
    accountsEmployee: accountsHOD,
});

const out = new URL('../assets/templates/signature-test.pdf', import.meta.url);
fs.writeFileSync(out, pdf);
console.log('Wrote', out.pathname, pdf.length);
await mongoose.disconnect();
