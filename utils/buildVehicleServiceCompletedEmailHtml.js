/**
 * Formal complete-service email — when Admin Officer submits Complete Service.
 * Combines the completion form + care/reminder page.
 * Omitted (red-lined): VEGA logo, page-2 header, signature boxes, thank-you footer, live.verp.cloud URL.
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

function noticeBoxHtml({ title, body, bg, border, titleColor, bodyColor }) {
    return `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 0;background:${bg};border:1px solid ${border};border-radius:8px;">
            <tr>
                <td style="padding:16px 18px;">
                    <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:${titleColor};margin:0 0 6px;">
                        ${esc(title)}
                    </div>
                    <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.55;color:${bodyColor};">
                        ${esc(body)}
                    </div>
                </td>
            </tr>
        </table>`;
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

function reminderGridHtml() {
    const cells = REMINDER_ITEMS.map(
        (item) => `
            <td width="50%" valign="top" style="padding:6px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #d5dee8;border-radius:6px;">
                    <tr>
                        <td style="padding:12px 14px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#1a2332;line-height:1.4;">
                            ${esc(item)}
                        </td>
                    </tr>
                </table>
            </td>`,
    );
    const rows = [];
    for (let i = 0; i < cells.length; i += 2) {
        const second = cells[i + 1] || '<td width="50%" style="padding:6px;"></td>';
        rows.push(`<tr>${cells[i]}${second}</tr>`);
    }
    return `
        <p style="margin:0 0 10px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#334155;line-height:1.55;">
            To maintain your vehicle in good operating condition and ensure safe driving, please continue to monitor the following regularly:
        </p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${rows.join('')}
        </table>`;
}

export function vehicleServiceCompletedSubject(vehicleName) {
    const name = String(vehicleName || '').trim() || 'vehicle';
    return `complete service - ${name}`;
}

export const VEHICLE_SERVICE_COMPLETED_SUBJECT = 'Vehicle Service Completed Successfully';

export function vehicleServiceCompletionTitle(serviceType) {
    const type = String(serviceType || 'Service').trim() || 'Service';
    return `VEHICLE ${type.toUpperCase()} COMPLETION`;
}

/**
 * @param {object} p
 * @param {string} [p.serviceType]
 * @param {string} [p.vehicleNumber]
 * @param {string} [p.vehicleAssetNumber]
 * @param {string} [p.assignedUser]
 * @param {string} [p.serviceCompletedDate]
 * @param {string} [p.vehicleReturnedDate]
 * @param {string} [p.currentKm]
 * @param {string} [p.companyPaidAmount]
 * @param {string} [p.employeePaidAmount]
 * @param {string} [p.serviceStatus]
 * @param {string} [p.adminOfficerName]
 * @param {string} [p.adminOfficerEmail]
 * @param {string} [p.detailsUrl]
 * @param {string} [p.fallbackNoteHtml]
 */
export function buildVehicleServiceCompletedEmailHtml(p = {}) {
    const serviceType = String(p.serviceType || 'Service').trim() || 'Service';
    const title = vehicleServiceCompletionTitle(serviceType);
    const detailsUrl = String(p.detailsUrl || '').trim();
    const fallback = String(p.fallbackNoteHtml || '').trim();
    const serviceStatus = String(p.serviceStatus || '').trim() || 'Completed - Vehicle Returned';

    const openErp = detailsUrl
        ? `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 0;background:#1b3a5f;border-radius:8px;">
            <tr>
                <td style="padding:16px 18px;text-align:center;">
                    <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;color:#ffffff;margin:0 0 12px;">
                        Access Vehicle ERP
                    </div>
                    <a href="${esc(detailsUrl)}" style="display:inline-block;background:#ffffff;color:#1b3a5f;text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.8px;padding:8px 22px;border-radius:4px;">OPEN ERP</a>
                </td>
            </tr>
        </table>`
        : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:16px 0;">
        <tr>
            <td align="center">
                <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:640px;max-width:640px;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
                    <tr>
                        <td style="background:#1b3a5f;padding:20px 24px 18px;">
                            <div style="font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:1.3;font-weight:700;color:#ffffff;letter-spacing:0.4px;">
                                ${esc(title)}
                            </div>
                            <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#e2e8f0;margin:8px 0 0;">
                                Service completed successfully - vehicle returned for normal use.
                            </div>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:24px 28px 28px;font-family:Arial,Helvetica,sans-serif;">
                            ${fallback}
                            ${noticeBoxHtml({
                                title: 'Service completed',
                                body: 'We are pleased to inform you that your vehicle service has been completed successfully, and the vehicle has been returned to you for normal use. Please find the service details below.',
                                bg: '#ecfdf3',
                                border: '#86efac',
                                titleColor: '#15803d',
                                bodyColor: '#166534',
                            })}
                            ${sectionHtml('Vehicle Service Information', [
                                `${inputFieldHtml('Vehicle number', p.vehicleNumber)}${inputFieldHtml('Vehicle asset number', p.vehicleAssetNumber)}`,
                                inputFieldHtml('Vehicle assigned users', p.assignedUser, '100%'),
                                `${inputFieldHtml('Service completed date', p.serviceCompletedDate)}${inputFieldHtml('Vehicle returned date', p.vehicleReturnedDate)}`,
                                `${inputFieldHtml('Current kilometer reading', p.currentKm)}${inputFieldHtml('Company paid amount', p.companyPaidAmount)}`,
                                `${inputFieldHtml('Employee paid amount', p.employeePaidAmount)}${inputFieldHtml('Service status', serviceStatus)}`,
                            ])}
                            ${noticeBoxHtml({
                                title: 'Return confirmation',
                                body: 'The assigned user confirms receipt of the vehicle after service and acknowledges that it has been returned for normal official use.',
                                bg: '#eef6fb',
                                border: '#bfdbfe',
                                titleColor: '#1d4ed8',
                                bodyColor: '#1e3a5f',
                            })}
                            ${sectionBarHtml('Important reminder')}
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f7;border:1px solid #e2e8ef;border-radius:0 0 8px 8px;">
                                <tr>
                                    <td style="padding:14px 16px 16px;">
                                        ${reminderGridHtml()}
                                    </td>
                                </tr>
                            </table>
                            ${noticeBoxHtml({
                                title: 'Report abnormal conditions immediately',
                                body: 'If you notice any abnormal condition or mechanical issue, please contact the Administration Officer immediately and arrange the necessary inspection or maintenance. Prompt reporting can help prevent further damage and reduce repair costs.',
                                bg: '#fff7ed',
                                border: '#fdba74',
                                titleColor: '#c2410c',
                                bodyColor: '#7c2d12',
                            })}
                            ${noticeBoxHtml({
                                title: 'Important note - GPS kilometer reading',
                                body: 'The current kilometer reading shown in this document is automatically retrieved from the GPS tracking system. If it does not match the reading displayed on the vehicle odometer, please contact the Administration Officer and arrange for the correct kilometer reading to be updated in the GPS system.',
                                bg: '#eff6ff',
                                border: '#93c5fd',
                                titleColor: '#1d4ed8',
                                bodyColor: '#1e3a5f',
                            })}
                            ${sectionHtml('Administration Officer Details', [
                                `${inputFieldHtml('Name', p.adminOfficerName)}${inputFieldHtml('Title', 'Administration Officer')}`,
                                inputFieldHtml('Email', p.adminOfficerEmail, '100%'),
                            ])}
                            ${openErp}
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;
}
