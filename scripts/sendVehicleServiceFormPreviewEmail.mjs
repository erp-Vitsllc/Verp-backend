/**
 * Send schedule + complete service email previews to razan.docs@gmail.com.
 * Run from VERP_backend: node scripts/sendVehicleServiceFormPreviewEmail.mjs
 */
import 'dotenv/config';
import nodemailer from 'nodemailer';
import { setupEmailSubjectTag } from '../utils/setupEmailSubjectTag.js';
import {
    buildVehicleServiceScheduledEmailHtml,
    vehicleServiceScheduledSubject,
} from '../utils/buildVehicleServiceScheduledEmailHtml.js';
import {
    buildVehicleServiceCompletedEmailHtml,
    vehicleServiceCompletedSubject,
} from '../utils/buildVehicleServiceCompletedEmailHtml.js';

setupEmailSubjectTag();

const TO = 'razan.docs@gmail.com';
const emailUser = (process.env.EMAIL_USER || process.env.VERP_EMAIL || '').trim();
const emailPass = (process.env.EMAIL_PASS || process.env.VERP_PASS || '').trim();

if (!emailUser || !emailPass) {
    console.error('Missing EMAIL_USER or EMAIL_PASS in .env');
    process.exit(1);
}

const transporter = nodemailer.createTransport({
    host: 'smtp.office365.com',
    port: 587,
    secure: false,
    auth: { user: emailUser, pass: emailPass },
});

const detailsUrl =
    'https://live.verp.cloud/HRM/Asset/Vehicle/details/64a1b2c3d4e5f67890123456/oil-service/64a1b2c3d4e5f67890123457';

const scheduledHtml = buildVehicleServiceScheduledEmailHtml({
    employeeName: 'Ahmad Ali',
    serviceType: 'Oil Service',
    garageName: 'Al Futtaim Motors Company LLC',
    garageLocation: 'CAR ZONE MAINT WORKSHOP LLC',
    garageContact: '050 199 8361',
    serviceStartDate: '2026-08-21',
    serviceEndDate: '2026-08-25',
    paymentMethod: 'Cash',
    amountToPay: 'AED 0',
    vehicleNumber: 'DXB A 12345',
    vehicleModelYear: '2022',
    vehicleAssetNumber: 'VH-001',
    assignedUser: 'Ahmad Ali',
    currentKm: '69,498 KM',
    adminOfficerName: 'NESMI SHAMSUDEEN',
    adminOfficerEmail: 'coordinator2@vegadigital.ae',
    detailsUrl,
    portalUrl: 'https://live.verp.cloud',
});

const completedHtml = buildVehicleServiceCompletedEmailHtml({
    serviceType: 'Oil Service',
    vehicleNumber: 'DXB A 12345',
    vehicleAssetNumber: 'VH-001',
    assignedUser: 'Ahmad Ali',
    serviceCompletedDate: '2026-08-19',
    vehicleReturnedDate: '2026-08-19',
    currentKm: '69,498 KM',
    companyPaidAmount: 'Warranty',
    employeePaidAmount: 'AED 0',
    serviceStatus: 'Completed - Vehicle Returned',
    adminOfficerName: 'NESMI SHAMSUDEEN',
    adminOfficerEmail: 'coordinator2@vegadigital.ae',
    detailsUrl,
});

const scheduled = await transporter.sendMail({
    from: `"VeRP Portal" <${emailUser}>`,
    to: TO,
    subject: vehicleServiceScheduledSubject('Oil Service'),
    html: scheduledHtml,
});
console.log(`Schedule mail sent (${scheduled.messageId || 'n/a'})`);

const completed = await transporter.sendMail({
    from: `"VeRP Portal" <${emailUser}>`,
    to: TO,
    subject: vehicleServiceCompletedSubject('Toyota Camry'),
    html: completedHtml,
});
console.log(`Complete mail sent (${completed.messageId || 'n/a'})`);
