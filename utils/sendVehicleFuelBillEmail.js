import nodemailer from 'nodemailer';
import { resolveFrontendBaseUrl } from './resolveFrontendBaseUrl.js';
import { getFallbackEmailNote } from './resolveEmployeeEmail.js';

function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function plateOf(asset) {
    return [asset?.plateEmirate, asset?.plateNumber].filter(Boolean).join(' ').trim();
}

function assignedPersonOf(asset) {
    if (asset?.assignedToType === 'Company' && asset?.assignedCompany) {
        const company = asset.assignedCompany;
        return company?.name || company?.nickName || 'Company';
    }
    const emp = asset?.assignedTo;
    if (emp && typeof emp === 'object') {
        const name = `${emp.firstName || ''} ${emp.lastName || ''}`.trim();
        return name || emp.employeeId || 'Assigned';
    }
    return 'Unassigned';
}

function formatAed(amount) {
    const n = Number(amount);
    const value = Number.isFinite(n) ? n : 0;
    return `AED ${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function inputFieldHtml(label, value, widthPct = '33.33%') {
    return `
        <td width="${widthPct}" valign="top" style="padding:8px 10px;">
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:10px;letter-spacing:0.8px;text-transform:uppercase;color:#8aa0b5;font-weight:700;margin:0 0 7px;">${esc(label)}</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #d5dee8;border-radius:6px;">
                <tr>
                    <td style="padding:12px 14px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a2332;font-weight:500;line-height:1.35;">
                        ${esc(value || '—')}
                    </td>
                </tr>
            </table>
        </td>`;
}

function sectionBoxHtml(fieldsHtml) {
    return `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f7;border:1px solid #e2e8ef;border-radius:10px;">
            <tr>
                <td style="padding:10px 8px 12px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                        <tr>${fieldsHtml}</tr>
                    </table>
                </td>
            </tr>
        </table>`;
}

function sectionTitleHtml(title) {
    return `<p style="margin:22px 0 10px;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase;color:#1b3a5f;">${esc(title)}</p>`;
}

/**
 * Create-fuel email body — matches the Fuel Update Report form
 * (blue month header, 3 vehicle fields, approved limit, official-use notice).
 */
export function fuelAllocationSubject(monthLabel) {
    return `${monthLabel || 'This month'} fuel allocation`;
}

export function buildVehicleFuelAllocationEmailHtml({
    asset,
    monthLabel,
    monthlyLimit,
    fallbackNoteHtml = '',
} = {}) {
    const subject = fuelAllocationSubject(monthLabel);
    const vehicleNumber = plateOf(asset) || '—';
    const vehicleAssetNumber = String(asset?.assetId || '').trim() || '—';
    const assignedPerson = assignedPersonOf(asset);
    const approvedLimit = formatAed(monthlyLimit);

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:16px 0;">
        <tr>
            <td align="center">
                <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:640px;max-width:640px;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
                    <tr>
                        <td style="background:#1b3a5f;padding:22px 28px;">
                            <h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:22px;line-height:1.3;font-weight:700;color:#ffffff;letter-spacing:0.3px;">
                                ${esc(subject)}
                            </h1>
                            <p style="margin:8px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.4;font-weight:500;color:#ffffff;opacity:.95;">
                                Subject: ${esc(subject)}
                            </p>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:24px 28px 28px;font-family:Arial,Helvetica,sans-serif;">
                            ${fallbackNoteHtml || ''}
                            ${sectionTitleHtml('Vehicle and assignment details')}
                            ${sectionBoxHtml(
                                `${inputFieldHtml('Vehicle number', vehicleNumber)}${inputFieldHtml('Vehicle asset number', vehicleAssetNumber)}${inputFieldHtml('Assigned person', assignedPerson)}`,
                            )}
                            ${sectionTitleHtml('Approved usage limit')}
                            ${sectionBoxHtml(
                                `${inputFieldHtml('Approved usage limit', approvedLimit, '50%')}<td width="50%" style="padding:8px 10px;"></td>`,
                            )}
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 8px;background:#fbf3e0;border:1px solid #e8c56b;border-radius:8px;">
                                <tr>
                                    <td style="padding:16px 18px;">
                                        <table role="presentation" cellpadding="0" cellspacing="0">
                                            <tr>
                                                <td valign="top" style="padding-right:12px;">
                                                    <div style="width:22px;height:22px;border-radius:11px;background:#b8860b;color:#ffffff;text-align:center;line-height:22px;font-family:Arial,Helvetica,sans-serif;font-weight:700;font-size:13px;">!</div>
                                                </td>
                                                <td valign="top">
                                                    <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:#b45309;margin:0 0 6px;">Important - Official use only</div>
                                                    <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.55;color:#5c4a32;">
                                                        Use petrol only for official purposes. For any additional trip or personal use, please inform your HOD and obtain permission before using the vehicle.
                                                    </div>
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                            <p style="margin:28px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#334155;line-height:1.6;">
                                Thank you for your cooperation and support.
                            </p>
                            <p style="margin:16px 0 8px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#334155;line-height:1.6;">
                                Best Regards,<br>
                                Vehicle Management Team<br>
                                <strong>VEGA DIGITAL IT SOLUTIONS LLC</strong>
                            </p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;
}

/**
 * Notify assignee / Admin Officer / (reportee if no user) / company email on fuel add,
 * and the previous summary template on close / 80% / 100%.
 */
export async function sendVehicleFuelBillEmail({
    to,
    cc = [],
    asset,
    monthLabel,
    amountUsed,
    monthlyLimit,
    kmRun,
    idleTimeLabel,
    action,
    fallbackNoteHtml = '',
    greetingName = '',
}) {
    try {
        const emailUser = process.env.EMAIL_USER?.trim();
        const emailPass = process.env.EMAIL_PASS?.trim();
        if (!emailUser || !emailPass || !to) return;

        const isClosed = action === 'closed';
        const isLimit100 = action === 'limitExceeded';
        const isLimit80 = action === 'limitWarning80';
        const isAdded = !isClosed && !isLimit100 && !isLimit80;
        const plate = plateOf(asset);
        const subjectAsset = plate || asset?.assetId || asset?.name || '';
        const subject = isAdded
            ? fuelAllocationSubject(monthLabel)
            : `[VeRP] ${
                  isClosed
                      ? 'Fuel bill closed'
                      : isLimit100
                        ? 'Monthly fuel limit reached (100%)'
                        : 'Fuel at 80% of monthly limit'
              } — ${subjectAsset}${monthLabel ? ` · ${monthLabel}` : ''}`;

        const transporter = nodemailer.createTransport({
            host: 'smtp.office365.com',
            port: 587,
            secure: false,
            auth: { user: emailUser, pass: emailPass },
        });

        const html = isAdded
            ? buildVehicleFuelAllocationEmailHtml({
                  asset,
                  monthLabel,
                  monthlyLimit,
                  fallbackNoteHtml,
              })
            : buildFuelAlertEmailHtml({
                  asset,
                  monthLabel,
                  amountUsed,
                  monthlyLimit,
                  kmRun,
                  idleTimeLabel,
                  isClosed,
                  isLimit100,
                  isLimit80,
                  fallbackNoteHtml,
                  greetingName,
                  plate,
                  subjectAsset,
              });

        const toAddr = String(to).trim();
        const ccList = (Array.isArray(cc) ? cc : [])
            .map((addr) => String(addr || '').trim())
            .filter((addr) => addr && addr.toLowerCase() !== toAddr.toLowerCase());

        const result = await transporter.sendMail({
            from: `"VeRP Portal" <${emailUser}>`,
            to: toAddr,
            ...(ccList.length ? { cc: ccList } : {}),
            subject,
            html,
        });
        return result;
    } catch (error) {
        console.error('[VehicleFuelBill] Email error:', error.message);
        return null;
    }
}

function buildFuelAlertEmailHtml({
    asset,
    monthLabel,
    amountUsed,
    monthlyLimit,
    kmRun,
    idleTimeLabel,
    isClosed,
    isLimit100,
    isLimit80,
    fallbackNoteHtml,
    greetingName,
    plate,
    subjectAsset,
}) {
    const actionLabel = isClosed
        ? 'Fuel bill closed'
        : isLimit100
          ? 'Monthly fuel limit reached (100%)'
          : 'Fuel at 80% of monthly limit';
    const base = (resolveFrontendBaseUrl() || '').replace(/\/$/, '');
    const link = asset?._id
        ? `${base}/HRM/Asset/Vehicle/details/${asset._id}?tab=fuel`
        : `${base}/HRM/Asset/Vehicle`;

    const rows = [
        { label: 'Vehicle', value: `${asset?.assetId || ''}${asset?.name ? ` — ${asset.name}` : ''}`.trim() },
        ...(plate ? [{ label: 'Plate', value: plate }] : []),
        { label: 'Month', value: monthLabel || '—' },
        { label: 'Amount used', value: formatAed(amountUsed) },
        ...(Number(monthlyLimit) > 0
            ? [
                  { label: 'Monthly limit', value: formatAed(monthlyLimit) },
                  {
                      label: '% of limit',
                      value: `${Math.min(999, Math.round((Number(amountUsed || 0) / Number(monthlyLimit)) * 100))}%`,
                  },
              ]
            : []),
        { label: 'Monthly KM', value: `${Number(kmRun || 0).toLocaleString(undefined, { maximumFractionDigits: 1 })} km` },
        { label: 'Idle time', value: idleTimeLabel || '—' },
        { label: 'Status', value: isLimit100 ? '100% of monthly limit' : isLimit80 ? '80% of monthly limit' : 'Closed' },
    ];

    const rowsHtml = rows
        .map(
            (row) =>
                `<tr><td style="padding:10px 14px;font-size:12px;color:#64748b;vertical-align:top;white-space:nowrap;">${esc(row.label)}</td><td style="padding:10px 14px;font-weight:600;color:#0f172a;">${esc(row.value)}</td></tr>`,
        )
        .join('');

    const detailLine = isClosed
        ? `The fuel bill for ${monthLabel || 'this month'} has been closed. No further petrol entries can be added for this month.`
        : isLimit100
          ? `The fuel amount for ${monthLabel || 'this month'} has reached 100% of the monthly limit.`
          : `The fuel amount for ${monthLabel || 'this month'} has reached 80% of the monthly limit.`;
    const headerColor = isLimit100 ? '#dc2626' : isLimit80 ? '#d97706' : '#059669';

    return `
            <div style="font-family:Segoe UI,sans-serif;color:#1e293b;line-height:1.6;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
                <div style="background:${headerColor};color:#fff;padding:18px 24px;">
                    <h1 style="margin:0;font-size:18px;">${esc(actionLabel)}</h1>
                    <p style="margin:8px 0 0;font-size:13px;opacity:.95;">${esc(subjectAsset)}${monthLabel ? ` · ${esc(monthLabel)}` : ''}</p>
                </div>
                <div style="padding:24px;">
                    ${fallbackNoteHtml || ''}
                    <p>Hello <strong>${esc(greetingName || 'there')}</strong>,</p>
                    <p style="color:#475569;">${esc(detailLine)}</p>
                    <table style="width:100%;margin:16px 0;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;border-collapse:collapse;">
                        ${rowsHtml}
                    </table>
                    <p style="text-align:center;margin:28px 0;">
                        <a href="${link}" style="background:${headerColor};color:#fff;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:700;display:inline-block;">Open fuel tab</a>
                    </p>
                </div>
            </div>`;
}

export { getFallbackEmailNote };
