/**
 * Send 80% / 100% / exceed fuel-update previews to razan.docs@gmail.com.
 * Run from VERP_backend: node scripts/sendFuelAllocationPreviewEmail.mjs
 */
import 'dotenv/config';
import { setupEmailSubjectTag } from '../utils/setupEmailSubjectTag.js';
import { sendVehicleFuelBillEmail } from '../utils/sendVehicleFuelBillEmail.js';

setupEmailSubjectTag();

const TO = 'razan.docs@gmail.com';

const emailUser = (process.env.EMAIL_USER || process.env.VERP_EMAIL || '').trim();
const emailPass = (process.env.EMAIL_PASS || process.env.VERP_PASS || '').trim();

if (!emailUser || !emailPass) {
    console.error('Missing EMAIL_USER or EMAIL_PASS in .env');
    process.exit(1);
}

const sampleAsset = {
    assetId: 'VH-001',
    name: 'Toyota Camry',
    plateEmirate: 'DXB',
    plateNumber: 'A 12345',
    assignedToType: 'Employee',
    assignedTo: { firstName: 'Ahmad', lastName: 'Ali', employeeId: 'EMP-001' },
};

const base = {
    to: TO,
    cc: [],
    asset: sampleAsset,
    monthLabel: 'August 2026',
    monthlyLimit: 1000,
    kmRun: 1840.5,
    idleTimeLabel: '3 hrs / 20 min',
    lastFuelUpdateAt: new Date(2026, 7, 18),
};

const previews = [
    { label: '80%', action: 'limitWarning80', amountUsed: 820 },
    { label: '100%', action: 'limitExceeded', amountUsed: 1000 },
    { label: 'exceed', action: 'limitExceeded', amountUsed: 1250 },
];

for (const preview of previews) {
    const result = await sendVehicleFuelBillEmail({
        ...base,
        action: preview.action,
        amountUsed: preview.amountUsed,
    });
    if (!result) {
        console.error(`Fuel ${preview.label} preview failed to send.`);
        process.exit(1);
    }
    console.log(`Fuel ${preview.label} mail sent (${result.messageId || 'n/a'})`);
}
