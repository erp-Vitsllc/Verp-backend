/**
 * Send a preview of the fuel-create allocation email to razan.docs@gmail.com.
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

const result = await sendVehicleFuelBillEmail({
    to: TO,
    cc: [],
    asset: {
        assetId: 'VH-001',
        name: 'Toyota Camry',
        plateEmirate: 'DXB',
        plateNumber: 'A 12345',
        assignedToType: 'Employee',
        assignedTo: { firstName: 'Ahmad', lastName: 'Ali', employeeId: 'EMP-001' },
    },
    monthLabel: 'August 2026',
    monthlyLimit: 1000,
    action: 'added',
});

if (!result) {
    console.error('Fuel allocation preview failed to send.');
    process.exit(1);
}

console.log(`Fuel allocation preview sent to ${TO} (messageId: ${result.messageId || 'n/a'})`);
