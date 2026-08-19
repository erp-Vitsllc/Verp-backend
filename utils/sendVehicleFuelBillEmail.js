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

/**
 * Notify company / assignee / reportee / Admin Officer / HR about a fuel bill add or close.
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
        const isLimit = action === 'limitExceeded';
        const actionLabel = isClosed
            ? 'Fuel bill closed'
            : isLimit
              ? 'Monthly fuel limit exceeded'
              : 'Fuel bill added';
        const plate = [asset?.plateEmirate, asset?.plateNumber].filter(Boolean).join(' ').trim();
        const subjectAsset = plate || asset?.assetId || asset?.name || '';
        const subject = `[VeRP] ${actionLabel} — ${subjectAsset}${monthLabel ? ` · ${monthLabel}` : ''}`;

        const transporter = nodemailer.createTransport({
            host: 'smtp.office365.com',
            port: 587,
            secure: false,
            auth: { user: emailUser, pass: emailPass },
        });

        const base = (resolveFrontendBaseUrl() || '').replace(/\/$/, '');
        const link = asset?._id
            ? `${base}/HRM/Asset/Vehicle/details/${asset._id}?tab=fuel`
            : `${base}/HRM/Asset/Vehicle`;

        const rows = [
            { label: 'Vehicle', value: `${asset?.assetId || ''}${asset?.name ? ` — ${asset.name}` : ''}`.trim() },
            ...(plate ? [{ label: 'Plate', value: plate }] : []),
            { label: 'Month', value: monthLabel || '—' },
            { label: 'Amount used', value: `AED ${Number(amountUsed || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
            ...(Number(monthlyLimit) > 0
                ? [{ label: 'Monthly limit', value: `AED ${Number(monthlyLimit).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` }]
                : []),
            { label: 'Monthly KM', value: `${Number(kmRun || 0).toLocaleString(undefined, { maximumFractionDigits: 1 })} km` },
            { label: 'Idle time', value: idleTimeLabel || '—' },
            { label: 'Status', value: isLimit ? 'Limit exceeded' : isClosed ? 'Closed' : 'Open' },
        ];

        const rowsHtml = rows
            .map(
                (row) =>
                    `<tr><td style="padding:10px 14px;font-size:12px;color:#64748b;vertical-align:top;white-space:nowrap;">${esc(row.label)}</td><td style="padding:10px 14px;font-weight:600;color:#0f172a;">${esc(row.value)}</td></tr>`,
            )
            .join('');

        const detailLine = isClosed
            ? `The fuel bill for ${monthLabel || 'this month'} has been closed. No further petrol entries can be added for this month.`
            : isLimit
              ? `The fuel amount for ${monthLabel || 'this month'} has reached or exceeded the monthly limit.`
              : `A petrol bill was recorded for ${monthLabel || 'this month'}.`;
        const headerColor = isLimit ? '#dc2626' : '#059669';

        const html = `
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

        const toAddr = String(to).trim();
        const ccList = (Array.isArray(cc) ? cc : [])
            .map((addr) => String(addr || '').trim())
            .filter((addr) => addr && addr.toLowerCase() !== toAddr.toLowerCase());

        await transporter.sendMail({
            from: `"VeRP Portal" <${emailUser}>`,
            to: toAddr,
            ...(ccList.length ? { cc: ccList } : {}),
            subject,
            html,
        });
    } catch (error) {
        console.error('[VehicleFuelBill] Email error:', error.message);
    }
}

export { getFallbackEmailNote };
