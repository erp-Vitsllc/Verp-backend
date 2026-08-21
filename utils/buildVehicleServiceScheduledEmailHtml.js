/**
 * Formal "Vehicle Service Scheduled" email — navy form layout.
 * Sent when Admin Officer completes Schedule / Reschedule for any service type.
 * Crossed-out mockup fields are omitted: MAINTENANCE title, Type of Repair, thank-you sign-off.
 */

function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function display(value) {
    const text = String(value ?? '').trim();
    return text || '—';
}

function inputFieldHtml(label, value, widthPct = '50%') {
    return `
        <td width="${widthPct}" valign="top" style="padding:8px 10px;">
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:10px;letter-spacing:0.8px;text-transform:uppercase;color:#8aa0b5;font-weight:700;margin:0 0 7px;">${esc(label)}</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #d5dee8;border-radius:6px;">
                <tr>
                    <td style="padding:12px 14px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a2332;font-weight:500;line-height:1.35;">
                        ${esc(display(value))}
                    </td>
                </tr>
            </table>
        </td>`;
}

function sectionBoxHtml(rowsHtml) {
    const rows = Array.isArray(rowsHtml) ? rowsHtml : [rowsHtml];
    return `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f7;border:1px solid #e2e8ef;border-radius:0 0 8px 8px;">
            <tr>
                <td style="padding:10px 8px 12px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                        ${rows.map((row) => `<tr>${row}</tr>`).join('')}
                    </table>
                </td>
            </tr>
        </table>`;
}

function sectionBarHtml(title) {
    return `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 0;background:#1b3a5f;border-radius:8px 8px 0 0;">
            <tr>
                <td style="padding:10px 16px;font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase;color:#ffffff;">
                    ${esc(title)}
                </td>
            </tr>
        </table>`;
}

function sectionHtml(title, rowsHtml) {
    return `${sectionBarHtml(title)}${sectionBoxHtml(rowsHtml)}`;
}

export function vehicleServiceScheduledSubject(serviceType) {
    const type = String(serviceType || '').trim() || 'Service';
    return `Vehicle Service Scheduled For ${type}`;
}

export const VEHICLE_SERVICE_SCHEDULED_SUBJECT = 'Vehicle Service Scheduled Notification';

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
 * @param {string} [p.vehicleNumber]
 * @param {string} [p.vehicleModelYear]
 * @param {string} [p.vehicleAssetNumber]
 * @param {string} [p.assignedUser]
 * @param {string} [p.currentKm]
 * @param {string} [p.adminOfficerName]
 * @param {string} [p.adminOfficerEmail]
 * @param {string} [p.detailsUrl]
 * @param {string} [p.portalUrl]
 * @param {string} [p.fallbackNoteHtml]
 */
export function buildVehicleServiceScheduledEmailHtml(p = {}) {
    const employeeName = String(p.employeeName || 'Employee').trim() || 'Employee';
    const serviceType = String(p.serviceType || 'Service').trim() || 'Service';
    const detailsUrl = String(p.detailsUrl || p.portalUrl || '').trim();
    const portalUrl = String(p.portalUrl || detailsUrl || '').trim();
    const fallback = String(p.fallbackNoteHtml || '').trim();

    const gpsNote = `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 8px;background:#fff7ed;border:1px solid #fdba74;border-radius:8px;">
            <tr>
                <td style="padding:16px 18px;">
                    <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:#c2410c;margin:0 0 6px;">
                        Important note - GPS kilometer reading
                    </div>
                    <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.55;color:#7c2d12;">
                        The current kilometer reading is automatically fetched from the GPS tracking system. If it does not match the vehicle odometer, please contact the Administration Officer and arrange for the current kilometer reading to be updated in the GPS system.
                    </div>
                </td>
            </tr>
        </table>`;

    const footerHtml = `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 0;">
            <tr>
                <td width="58%" valign="top" style="padding-right:12px;">
                    <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:#1b3a5f;letter-spacing:0.4px;">
                        ${esc(display(p.adminOfficerName))}
                    </div>
                    <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#475569;margin:4px 0 6px;">
                        Administration Officer - Further Assistance
                    </div>
                    <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#1d4ed8;">
                        ${esc(display(p.adminOfficerEmail))}
                    </div>
                </td>
                <td width="42%" valign="top">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#1b3a5f;border-radius:8px;">
                        <tr>
                            <td style="padding:14px 16px;text-align:center;">
                                <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;color:#ffffff;margin:0 0 6px;">
                                    Access Vehicle ERP
                                </div>
                                <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#cbd5e1;margin:0 0 10px;word-break:break-all;">
                                    ${esc(display(portalUrl))}
                                </div>
                                ${
                                    detailsUrl
                                        ? `<a href="${esc(detailsUrl)}" style="display:inline-block;background:#ffffff;color:#1b3a5f;text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.8px;padding:8px 22px;border-radius:4px;">OPEN</a>`
                                        : ''
                                }
                            </td>
                        </tr>
                    </table>
                </td>
            </tr>
        </table>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${esc(vehicleServiceScheduledSubject(serviceType))}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:16px 0;">
        <tr>
            <td align="center">
                <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:640px;max-width:640px;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
                    <tr>
                        <td style="padding:0;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                    <td width="8" style="width:8px;background:#14b8a6;"></td>
                                    <td style="background:#1b3a5f;padding:20px 24px 18px;">
                                        <div style="font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:1.3;font-weight:700;color:#ffffff;letter-spacing:0.4px;">
                                            VEHICLE SERVICE SCHEDULED FOR
                                        </div>
                                        <div style="font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:700;color:#f59e0b;margin:6px 0 8px;">
                                            ${esc(serviceType)}
                                        </div>
                                        <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#e2e8f0;">
                                            Garage appointment, vehicle information and GPS notice
                                        </div>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:24px 28px 28px;font-family:Arial,Helvetica,sans-serif;">
                            ${fallback}
                            ${sectionBoxHtml(inputFieldHtml('Recipient', `Dear ${employeeName}`, '100%'))}
                            <p style="margin:16px 0 4px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#334155;line-height:1.6;">
                                Your vehicle has been scheduled for the repair type stated above. Please find the garage details and service schedule below.
                            </p>
                            ${sectionHtml('Service Details', [
                                inputFieldHtml('Garage name', p.garageName, '100%'),
                                `${inputFieldHtml('Garage location', p.garageLocation)}${inputFieldHtml('Garage contact number', p.garageContact)}`,
                            ])}
                            ${sectionHtml('Service Schedule', [
                                `${inputFieldHtml('Service start date', p.serviceStartDate)}${inputFieldHtml('Service end date', p.serviceEndDate)}`,
                            ])}
                            ${sectionHtml('Payment Information', [
                                `${inputFieldHtml('Payment method', p.paymentMethod)}${inputFieldHtml('Amount to pay', p.amountToPay)}`,
                            ])}
                            ${sectionHtml('Vehicle Information', [
                                `${inputFieldHtml('Vehicle number', p.vehicleNumber, '33.33%')}${inputFieldHtml('Vehicle model year', p.vehicleModelYear, '33.33%')}${inputFieldHtml('Vehicle asset number', p.vehicleAssetNumber, '33.33%')}`,
                                `${inputFieldHtml('Assigned user', p.assignedUser)}${inputFieldHtml('Current kilometer reading', p.currentKm)}`,
                            ])}
                            ${gpsNote}
                            ${footerHtml}
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;
}
