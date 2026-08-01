/**
 * Formal "Vehicle Service Scheduled Notification" email body.
 * Matches the Vehicle Management Team plain-letter style (bold labels / headings).
 */

function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function bullet(label, value) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    return `<li style="margin:0 0 6px;"><strong>${esc(label)}:</strong> ${esc(text)}</li>`;
}

function section(title, itemsHtml) {
    const body = String(itemsHtml || '').trim();
    if (!body) return '';
    return `
        <p style="margin:18px 0 8px;font-size:15px;font-weight:700;">${esc(title)}</p>
        <ul style="margin:0 0 4px;padding-left:22px;">
            ${body}
        </ul>`;
}

/**
 * @param {object} p
 * @param {string} p.employeeName
 * @param {string} p.serviceType
 * @param {string} [p.garageName]
 * @param {string} [p.garageLocation]
 * @param {string} [p.garageContact]
 * @param {string} [p.serviceStartDate]
 * @param {string} [p.serviceEndDate]
 * @param {string} [p.paymentMethod]
 * @param {string} [p.amountToPay]
 * @param {string} [p.currentKm]
 * @param {string} [p.adminOfficerName]
 * @param {string} [p.adminOfficerContact]
 * @param {string} [p.adminOfficerEmail]
 * @param {string} [p.companyName]
 * @param {string} [p.fallbackNoteHtml]
 */
export function buildVehicleServiceScheduledEmailHtml(p = {}) {
    const employeeName = String(p.employeeName || 'Employee').trim() || 'Employee';
    const serviceType = String(p.serviceType || 'service').trim() || 'service';
    const companyName = String(p.companyName || '').trim() || 'Company';

    const serviceDetails = [
        bullet('Garage Name', p.garageName),
        bullet('Garage Location', p.garageLocation),
        bullet('Garage Contact Number', p.garageContact),
    ].join('');

    const serviceSchedule = [
        bullet('Service Start Date', p.serviceStartDate),
        bullet('Service End Date', p.serviceEndDate),
    ].join('');

    const paymentInfo = [
        bullet('Payment Method', p.paymentMethod),
        bullet('Amount to Pay', p.amountToPay),
    ].join('');

    const vehicleInfo = [bullet('Current Kilometer Reading', p.currentKm)].join('');

    const adminDetails = [
        bullet('Name', p.adminOfficerName),
        bullet('Contact Number', p.adminOfficerContact),
        bullet('Email Address', p.adminOfficerEmail),
    ].join('');

    const fallback = String(p.fallbackNoteHtml || '').trim();

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Vehicle Service Scheduled Notification</title>
</head>
<body style="margin:0;padding:0;background:#ffffff;">
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.55;max-width:640px;margin:0 auto;padding:24px 20px;">
        ${fallback}
        <p style="margin:0 0 16px;"><strong>Subject:</strong> Vehicle Service Scheduled Notification</p>
        <p style="margin:0 0 14px;"><strong>Dear ${esc(employeeName)},</strong></p>
        <p style="margin:0 0 14px;">
            Your vehicle has been scheduled for ${esc(serviceType)}. Please find the garage details and service schedule below:
        </p>
        ${section('Service Details', serviceDetails)}
        ${section('Service Schedule', serviceSchedule)}
        ${section('Payment Information', paymentInfo)}
        ${section('Vehicle Information', vehicleInfo)}
        <p style="margin:16px 0 14px;">
            <strong>Note:</strong> The current kilometer reading is automatically fetched from the GPS tracking system. If the kilometer reading displayed above does not match your vehicle's odometer reading, please contact the Administration Officer and update the current kilometer reading in the GPS system.
        </p>
        <p style="margin:0 0 8px;">
            If you require any further assistance, please contact the Administration Officer below:
        </p>
        ${section('Administration Officer Details', adminDetails)}
        <p style="margin:18px 0 14px;">Thank you for your cooperation.</p>
        <p style="margin:0;">Best Regards,</p>
        <p style="margin:4px 0 0;"><strong>Vehicle Management Team</strong></p>
        <p style="margin:4px 0 0;"><strong>${esc(companyName)}</strong></p>
    </div>
</body>
</html>`;
}

export const VEHICLE_SERVICE_SCHEDULED_SUBJECT = 'Vehicle Service Scheduled Notification';
