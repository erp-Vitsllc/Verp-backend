import nodemailer from 'nodemailer';
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

function formatDdMmYyyy(value) {
    const d = value instanceof Date ? value : value ? new Date(value) : null;
    if (!d || Number.isNaN(d.getTime())) return '—';
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `${dd}/${mm}/${d.getFullYear()}`;
}

function formatKm(kmRun) {
    return `${Number(kmRun || 0).toLocaleString('en-US', { maximumFractionDigits: 1 })} km`;
}

function remainingBalance(monthlyLimit, amountUsed) {
    return Number(monthlyLimit || 0) - Number(amountUsed || 0);
}

function formatAed(amount) {
    const n = Number(amount);
    const value = Number.isFinite(n) ? n : 0;
    return `AED ${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function consumedPercent(monthlyLimit, amountUsed) {
    const cap = Number(monthlyLimit);
    const used = Number(amountUsed);
    if (!Number.isFinite(cap) || cap <= 0) return 0;
    return Math.min(999, Math.round((used / cap) * 100));
}

function emptyFieldHtml(widthPct = '33.33%') {
    return `<td width="${widthPct}" style="padding:8px 10px;"></td>`;
}

function noticeBoxHtml({ icon, title, body, bg, border, titleColor, bodyColor }) {
    return `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 8px;background:${bg};border:1px solid ${border};border-radius:8px;">
            <tr>
                <td style="padding:16px 18px;">
                    <table role="presentation" cellpadding="0" cellspacing="0">
                        <tr>
                            <td valign="top" style="padding-right:12px;">
                                <div style="width:22px;height:22px;border-radius:11px;background:${titleColor};color:#ffffff;text-align:center;line-height:22px;font-family:Arial,Helvetica,sans-serif;font-weight:700;font-size:13px;">${esc(icon)}</div>
                            </td>
                            <td valign="top">
                                <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:${titleColor};margin:0 0 6px;">${esc(title)}</div>
                                <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.55;color:${bodyColor};">
                                    ${esc(body)}
                                </div>
                            </td>
                        </tr>
                    </table>
                </td>
            </tr>
        </table>`;
}

function officialUsePolicyHtml() {
    return `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0 8px;background:#e8f4f2;border:1px solid #b7d9d3;border-radius:8px;">
            <tr>
                <td style="padding:16px 18px;">
                    <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;color:#1b3a5f;margin:0 0 6px;">Official use policy</div>
                    <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.55;color:#334155;">
                        Use petrol only for official use. Any additional trips or personal use must be reported to your HOD for further permission.
                    </div>
                </td>
            </tr>
        </table>`;
}

function reportSignOffHtml() {
    return `
        <p style="margin:28px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#334155;line-height:1.6;">
            Thank you for your cooperation and support.
        </p>
        <p style="margin:16px 0 8px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#334155;line-height:1.6;">
            Best Regards,<br>
            Vehicle Management Team<br>
            <strong>VEGA DIGITAL IT SOLUTIONS LLC</strong>
        </p>`;
}

function wrapFuelReportEmail({ title, fallbackNoteHtml = '', bodyHtml }) {
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
                        <td style="background:#1b3a5f;padding:22px 28px;">
                            <h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:22px;line-height:1.3;font-weight:700;color:#ffffff;letter-spacing:0.3px;">
                                ${esc(title)}
                            </h1>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:24px 28px 28px;font-family:Arial,Helvetica,sans-serif;">
                            ${fallbackNoteHtml || ''}
                            ${bodyHtml}
                            ${reportSignOffHtml()}
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;
}

function vehicleDetailsSectionHtml(asset) {
    return `
        ${sectionTitleHtml('Vehicle and assignment details')}
        ${sectionBoxHtml(
            `${inputFieldHtml('Vehicle number', plateOf(asset) || '—')}${inputFieldHtml('Vehicle asset number', String(asset?.assetId || '').trim() || '—')}${inputFieldHtml('Assigned person', assignedPersonOf(asset))}`,
        )}`;
}

/**
 * Create-fuel email body — matches the Fuel Update Report form
 * (blue month header, 3 vehicle fields, approved limit, official-use notice).
 */
export function fuelAllocationSubject(monthLabel) {
    return `${monthLabel || 'This month'} fuel allocation`;
}

export function fuelUpdateReportSubject(monthLabel, percent) {
    return `${monthLabel || 'This month'} fuel update report ${percent}%`;
}

export function fuelUsageReportSubject(monthLabel) {
    return `${monthLabel || 'This month'} fuel usage report`;
}

export function buildVehicleFuelClosedReportEmailHtml({
    asset,
    monthLabel,
    monthlyLimit,
    amountUsed,
    kmRun,
    idleTimeLabel,
    lastFuelUpdateAt,
    fallbackNoteHtml = '',
} = {}) {
    const title = fuelUsageReportSubject(monthLabel);
    const used = Number(amountUsed || 0);
    const cap = Number(monthlyLimit || 0);
    const pct = consumedPercent(cap, used);
    const remaining = Math.max(0, remainingBalance(cap, used));
    const exceeded = used > cap;
    const excessValue = exceeded ? formatAed(used - cap) : 'NIL';
    const monthText = monthLabel || 'this month';

    const outcome = exceeded
        ? {
              title: 'Above approved limit',
              body: 'Avoid additional fuel usage. Continued excess use may result in disciplinary action or deductions under company policy.',
              bg: '#fde8e8',
              border: '#f0a0a0',
              titleColor: '#b91c1c',
              bodyColor: '#7f1d1d',
          }
        : {
              title: 'Within approved limit',
              body: `Fuel usage is within the approved ${monthText} limit. Continue responsible use in accordance with company rules.`,
              bg: '#e8f8ee',
              border: '#86d3a5',
              titleColor: '#15803d',
              bodyColor: '#166534',
          };

    const bodyHtml = `
        ${vehicleDetailsSectionHtml(asset)}
        ${sectionTitleHtml('Fuel usage summary')}
        ${sectionBoxHtml([
            `${inputFieldHtml('Approved usage limit', formatAed(cap))}${inputFieldHtml('Consumed amount', formatAed(used))}${inputFieldHtml('Consumed percentage', `${pct}%`)}`,
            `${inputFieldHtml('Last fuel update date in ERP', formatDdMmYyyy(lastFuelUpdateAt))}${inputFieldHtml('Remaining balance', formatAed(remaining))}${inputFieldHtml('Excess usage', excessValue)}`,
            `${inputFieldHtml('Used KM', formatKm(kmRun), '50%')}${inputFieldHtml('Idle time', idleTimeLabel || '0 hrs / 0 min', '50%')}`,
        ])}
        ${sectionTitleHtml('Review outcome')}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px;background:${outcome.bg};border:1px solid ${outcome.border};border-radius:8px;">
            <tr>
                <td style="padding:16px 18px;">
                    <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;color:${outcome.titleColor};margin:0 0 6px;">${esc(outcome.title)}</div>
                    <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.55;color:${outcome.bodyColor};">
                        ${esc(outcome.body)}
                    </div>
                </td>
            </tr>
        </table>
        ${officialUsePolicyHtml()}`;
    return wrapFuelReportEmail({ title, fallbackNoteHtml, bodyHtml });
}

export function buildVehicleFuelAllocationEmailHtml({
    asset,
    monthLabel,
    monthlyLimit,
    fallbackNoteHtml = '',
} = {}) {
    const title = fuelAllocationSubject(monthLabel);
    const approvedLimit = formatAed(monthlyLimit);
    const bodyHtml = `
        ${vehicleDetailsSectionHtml(asset)}
        ${sectionTitleHtml('Approved usage limit')}
        ${sectionBoxHtml(`${inputFieldHtml('Approved usage limit', approvedLimit, '50%')}${emptyFieldHtml('50%')}`)}
        ${noticeBoxHtml({
            icon: '!',
            title: 'Important - Official use only',
            body: 'Use petrol only for official purposes. For any additional trip or personal use, please inform your HOD and obtain permission before using the vehicle.',
            bg: '#fbf3e0',
            border: '#e8c56b',
            titleColor: '#b45309',
            bodyColor: '#5c4a32',
        })}`;
    return wrapFuelReportEmail({ title, fallbackNoteHtml, bodyHtml });
}

export function buildVehicleFuelLimitReportEmailHtml({
    asset,
    monthLabel,
    monthlyLimit,
    amountUsed,
    kmRun,
    idleTimeLabel,
    lastFuelUpdateAt,
    fallbackNoteHtml = '',
} = {}) {
    const used = Number(amountUsed || 0);
    const cap = Number(monthlyLimit || 0);
    const pct = consumedPercent(cap, used);
    const title = fuelUpdateReportSubject(monthLabel, pct);
    const remaining = remainingBalance(cap, used);
    const limitLabel = formatAed(cap);
    const warningTitle = `${pct}% of the monthly fuel limit has been used`;
    const warningBody =
        pct >= 100
            ? `Your limit has hit the monthly limit of ${limitLabel}. Follow company rules and obtain permission before any further fuel use.`
            : `Your usage has hit ${pct}% of the monthly limit of ${limitLabel}. Use fuel carefully and follow company rules to avoid further deductions.`;

    const bodyHtml = `
        ${vehicleDetailsSectionHtml(asset)}
        ${sectionTitleHtml('Fuel usage summary')}
        ${sectionBoxHtml([
            `${inputFieldHtml('Approved usage limit', formatAed(cap))}${inputFieldHtml('Consumed amount', formatAed(used))}${inputFieldHtml('Consumed percentage', `${pct}%`)}`,
            `${inputFieldHtml('Last fuel update date in ERP', formatDdMmYyyy(lastFuelUpdateAt), '50%')}${inputFieldHtml('Remaining balance', formatAed(remaining), '50%')}`,
            `${inputFieldHtml('Used KM', formatKm(kmRun), '50%')}${inputFieldHtml('Idle time', idleTimeLabel || '0 hrs / 0 min', '50%')}`,
        ])}
        ${noticeBoxHtml({
            icon: 'i',
            title: warningTitle,
            body: warningBody,
            bg: '#fbf3e0',
            border: '#e8c56b',
            titleColor: '#c05621',
            bodyColor: '#5c4a32',
        })}
        ${officialUsePolicyHtml()}`;
    return wrapFuelReportEmail({ title, fallbackNoteHtml, bodyHtml });
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

function sectionBoxHtml(rowsHtml) {
    const rows = Array.isArray(rowsHtml) ? rowsHtml : [rowsHtml];
    return `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f7;border:1px solid #e2e8ef;border-radius:10px;">
            <tr>
                <td style="padding:10px 8px 12px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                        ${rows.map((row) => `<tr>${row}</tr>`).join('')}
                    </table>
                </td>
            </tr>
        </table>`;
}

function sectionTitleHtml(title) {
    return `<p style="margin:22px 0 10px;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase;color:#1b3a5f;">${esc(title)}</p>`;
}

/**
 * Notify assignee / Admin Officer / (reportee if no user) / company email on fuel add,
 * and the form report on 80% / 100% / close.
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
    lastFuelUpdateAt,
    action,
    fallbackNoteHtml = '',
}) {
    try {
        const emailUser = process.env.EMAIL_USER?.trim();
        const emailPass = process.env.EMAIL_PASS?.trim();
        if (!emailUser || !emailPass || !to) return;

        const isClosed = action === 'closed';
        const isLimitAlert = action === 'limitWarning80' || action === 'limitExceeded';
        const isAdded = !isClosed && !isLimitAlert;
        const usedPct = consumedPercent(monthlyLimit, amountUsed);
        const subject = isAdded
            ? fuelAllocationSubject(monthLabel)
            : isLimitAlert
              ? fuelUpdateReportSubject(monthLabel, usedPct)
              : fuelUsageReportSubject(monthLabel);

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
            : isLimitAlert
              ? buildVehicleFuelLimitReportEmailHtml({
                    asset,
                    monthLabel,
                    monthlyLimit,
                    amountUsed,
                    kmRun,
                    idleTimeLabel,
                    lastFuelUpdateAt,
                    fallbackNoteHtml,
                })
              : buildVehicleFuelClosedReportEmailHtml({
                    asset,
                    monthLabel,
                    monthlyLimit,
                    amountUsed,
                    kmRun,
                    idleTimeLabel,
                    lastFuelUpdateAt,
                    fallbackNoteHtml,
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

export { getFallbackEmailNote };
