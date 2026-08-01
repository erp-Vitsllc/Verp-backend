/**
 * Formal "Vehicle Service Completion & Return Notification" email body.
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

const REMINDER_ITEMS = [
    'Coolant level',
    'Tyre condition and air pressure',
    'Engine oil level',
    'Battery condition',
    'Vehicle warning indicators',
    'Unusual mechanical sounds or vibrations',
    'Any other performance-related issues',
];

/**
 * @param {object} p
 * @param {string} p.employeeName
 * @param {string} [p.serviceCompletedDate]
 * @param {string} [p.vehicleReturnedDate]
 * @param {string} [p.currentKm]
 * @param {string} [p.companyPaidAmount]
 * @param {string} [p.employeePaidAmount]
 * @param {string} [p.adminOfficerName]
 * @param {string} [p.adminOfficerContact]
 * @param {string} [p.adminOfficerEmail]
 * @param {string} [p.companyName]
 * @param {string} [p.fallbackNoteHtml]
 */
export function buildVehicleServiceCompletedEmailHtml(p = {}) {
    const employeeName = String(p.employeeName || 'Employee').trim() || 'Employee';
    const companyName = String(p.companyName || '').trim() || 'Company';

    const serviceInfo = [
        bullet('Service Completed Date', p.serviceCompletedDate),
        bullet('Vehicle Returned Date', p.vehicleReturnedDate),
        bullet('Current Kilometer Reading', p.currentKm),
        bullet('Company Paid Amount', p.companyPaidAmount),
        bullet('Employee Paid Amount', p.employeePaidAmount),
    ].join('');

    const adminDetails = [
        bullet('Name', p.adminOfficerName),
        bullet('Contact Number', p.adminOfficerContact),
        bullet('Email Address', p.adminOfficerEmail),
    ].join('');

    const reminderBullets = REMINDER_ITEMS.map(
        (item) => `<li style="margin:0 0 6px;">${esc(item)}</li>`,
    ).join('');

    const fallback = String(p.fallbackNoteHtml || '').trim();

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Vehicle Service Completion &amp; Return Notification</title>
</head>
<body style="margin:0;padding:0;background:#ffffff;">
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.55;max-width:640px;margin:0 auto;padding:24px 20px;">
        ${fallback}
        <p style="margin:0 0 16px;font-size:18px;font-weight:700;">Vehicle Service Completion &amp; Return Notification</p>
        <p style="margin:0 0 16px;"><strong>Subject:</strong> Vehicle Service Completed Successfully</p>
        <p style="margin:0 0 14px;">Dear <strong>${esc(employeeName)}</strong>,</p>
        <p style="margin:0 0 10px;">
            We are pleased to inform you that your vehicle service has been completed successfully, and the vehicle has been returned to you for normal use.
        </p>
        <p style="margin:0 0 14px;">Please find the service details below.</p>

        <p style="margin:18px 0 8px;font-size:15px;font-weight:700;">Vehicle Service Information</p>
        <ul style="margin:0 0 4px;padding-left:22px;">
            ${serviceInfo}
        </ul>

        <p style="margin:18px 0 8px;font-size:15px;font-weight:700;">Important Reminder</p>
        <p style="margin:0 0 8px;">
            To maintain your vehicle in good operating condition and ensure safe driving, please continue to monitor the following regularly:
        </p>
        <ul style="margin:0 0 10px;padding-left:22px;">
            ${reminderBullets}
        </ul>
        <p style="margin:0 0 14px;">
            If you notice any abnormal condition or mechanical issue, please contact the Administration Officer immediately and arrange for the necessary inspection or maintenance. Prompt reporting can help prevent further damage and reduce repair costs.
        </p>

        <p style="margin:18px 0 8px;font-size:15px;font-weight:700;">Important Note</p>
        <p style="margin:0 0 14px;">
            The current kilometer reading shown above is automatically retrieved from the GPS tracking system. If the kilometer reading does not match the reading displayed on your vehicle odometer, please contact the Administration Officer and arrange for the correct kilometer reading to be updated in the GPS system.
        </p>

        <p style="margin:18px 0 8px;font-size:15px;font-weight:700;">Administration Officer Details</p>
        <p style="margin:0 0 8px;">For any additional assistance, please contact:</p>
        <ul style="margin:0 0 4px;padding-left:22px;">
            ${adminDetails}
        </ul>

        <p style="margin:18px 0 14px;">Thank you for your cooperation and support.</p>
        <p style="margin:0;">Best Regards,</p>
        <p style="margin:4px 0 0;"><strong>Vehicle Management Team</strong></p>
        <p style="margin:4px 0 0;"><strong>${esc(companyName)}</strong></p>
    </div>
</body>
</html>`;
}

export const VEHICLE_SERVICE_COMPLETED_SUBJECT = 'Vehicle Service Completed Successfully';
