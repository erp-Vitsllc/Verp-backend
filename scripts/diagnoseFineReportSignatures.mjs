import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import Fine from '../models/Fine.js';
import { resolveAssetLossFineReportSignatures } from '../utils/resolveAssetLossFineReportSignatures.js';
import { loadSignatureImageBytes } from '../utils/loadSignatureImageBytes.js';
import { getDepartmentHOD } from '../utils/getDepartmentHOD.js';

await connectDB();

const fine = await Fine.findOne({ fineStatus: 'Approved', assetId: { $exists: true, $ne: null } })
    .sort({ updatedAt: -1 })
    .lean();

if (!fine) {
    console.log('No approved asset fine found');
    process.exit(0);
}

const empId = fine.assignedEmployees?.find((e) => e.employeeId && !e.employeeId.includes('VEGA-HR'))?.employeeId;
const hrHOD = await getDepartmentHOD('hr');
const accountsHOD = await getDepartmentHOD('finance');

const sigs = await resolveAssetLossFineReportSignatures({
    assignedEmployeeId: empId,
    hrEmployee: hrHOD,
    accountsEmployee: accountsHOD,
    fine,
});

for (const role of ['employee', 'hod', 'hr', 'accounts']) {
    const meta = sigs[role];
    const bytes = await loadSignatureImageBytes(meta?.signature || meta);
    console.log(role, {
        name: meta?.name,
        hasSigField: !!(meta?.signature?.url || meta?.signature?.publicId),
        urlResolved: !!meta?.url,
        bytes: bytes?.length || 0,
        key: meta?.signature?.publicId || meta?.signature?.url,
    });
}

await mongoose.disconnect();
