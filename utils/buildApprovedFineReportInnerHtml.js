import {
    buildAssetLossFineAcknowledgementHtml,
    formatMoney,
} from './buildAssetLossFineEmailFields.js';

function esc(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function money(value) {
    return `${formatMoney(value)} AED`;
}

const NAVY = '#1a3e63';
const TEAL = '#11a7a1';
const INK = '#1a3e63';
const MUTED = '#8aa0b5';
const LABEL_BG = '#eef6ff';
const BOX_BG = '#eaf2f8';
const LINE = '#d5dee8';
const RED = '#a31d1d';

function fieldCard(label, value, { accent = false } = {}) {
    const border = accent ? `1.5px solid ${TEAL}` : `1px solid ${LINE}`;
    return `
        <div style="border:${border};border-radius:6px;padding:7px 10px;background:#ffffff;min-height:42px;">
            <div style="font-size:8px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED};margin-bottom:3px;">${esc(label)}</div>
            <div style="font-size:12px;font-weight:bold;color:${INK};word-wrap:break-word;">${value}</div>
        </div>`;
}

function pairCards(leftLabel, leftValue, rightLabel, rightValue, { leftAccent = false } = {}) {
    return `
        <tr>
            <td width="50%" valign="top" style="width:50%;padding:0 5px 8px 0;">
                ${fieldCard(leftLabel, leftValue, { accent: leftAccent })}
            </td>
            <td width="50%" valign="top" style="width:50%;padding:0 0 8px 5px;">
                ${fieldCard(rightLabel, rightValue)}
            </td>
        </tr>`;
}

function tableLabel() {
    return `padding:8px 8px;background:${LABEL_BG};border:1px solid ${LINE};font-size:8px;font-weight:bold;letter-spacing:0.05em;text-transform:uppercase;color:${MUTED};width:24%;`;
}

function tableValue() {
    return `padding:8px 8px;background:#ffffff;border:1px solid ${LINE};font-size:11px;font-weight:bold;color:${NAVY};width:26%;`;
}

function moneyRow(l1, v1, l2, v2) {
    return `
        <tr>
            <td style="${tableLabel()}">${esc(l1)}</td>
            <td style="${tableValue()}">${esc(v1)}</td>
            <td style="${tableLabel()}">${esc(l2)}</td>
            <td style="${tableValue()}">${esc(v2)}</td>
        </tr>`;
}

function descriptionBox(rawDescription) {
    const lines = String(rawDescription || '')
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);
    const body = lines
        .map((line, index) => {
            const isDiscountNote = /%|discount applies/i.test(line) && index > 0;
            const color = isDiscountNote ? RED : NAVY;
            return `<div style="font-size:12px;font-weight:bold;color:${color};line-height:1.45;${index ? 'margin-top:4px;' : ''}">${esc(line)}</div>`;
        })
        .join('');
    return `
        <div style="border:1px solid ${LINE};border-radius:6px;background:${BOX_BG};padding:8px 12px 10px;">
            <div style="font-size:8px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED};margin-bottom:6px;">Fine description</div>
            ${body || `<div style="font-size:12px;font-weight:bold;color:${NAVY};">—</div>`}
        </div>`;
}

function sigCard(label, sig, { last = false } = {}) {
    const name = sig?.name ? esc(sig.name) : '';
    const url = sig?.url ? esc(sig.url) : '';
    const img = url
        ? `<img src="${url}" alt="" style="max-height:38px;max-width:100px;object-fit:contain;display:block;margin:6px auto 0;" />`
        : `<div style="height:38px;margin:10px 10px 0;border-bottom:1px solid #94a3b8;"></div>`;
    return `<td width="25%" valign="top" style="width:25%;padding:${last ? '0 0 0 4px' : '0 4px 0 0'};">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;border:1px solid ${LINE};border-radius:4px;">
            <tr>
                <td style="background:${NAVY};color:#ffffff;padding:6px 4px;text-align:center;font-size:7px;font-weight:bold;letter-spacing:0.05em;text-transform:uppercase;">${esc(label)}</td>
            </tr>
            <tr>
                <td style="background:#ffffff;padding:6px 6px 8px;text-align:center;height:62px;vertical-align:bottom;">
                    ${img}
                    ${name ? `<div style="font-size:8px;margin-top:6px;color:${MUTED};font-weight:bold;">${name}</div>` : ''}
                </td>
            </tr>
        </table>
    </td>`;
}

function employeePayableAmount(fields, rawPayableAmount) {
    const total = Number(fields.totalFine) || 0;
    const yours = Number(rawPayableAmount || fields.yourFinePayment) || 0;
    if (String(fields.fineCategory || '').toLowerCase().includes('group') && yours > 0) {
        return yours;
    }
    return total || yours;
}

function monthlyAmount(fields, payable) {
    const yours = Number(fields.yourFinePayment) || 0;
    const monthly = Number(fields.monthlyDeduction) || 0;
    const months = yours > 0 && monthly > 0 ? Math.max(1, Math.round(yours / monthly)) : 1;
    return payable / months;
}

/**
 * Report body: header + field cards, then the redesigned lower block
 * (description box, deduction tables, navy total bar, acknowledgement, signature cards).
 */
export function buildApprovedFineReportInnerHtml(
    fields,
    {
        signatureUrls = null,
        includeSignatures = false,
        includeAcknowledgement = false,
        includeFooter = false,
        rawPayableAmount = 0,
    } = {},
) {
    const title = fields?.reportTitle || 'FINE REPORT';
    const category = String(fields?.fineCategory || 'Single Fine').toUpperCase();
    const fineId = fields?.fineId || '—';
    const payable = employeePayableAmount(fields, rawPayableAmount);
    const monthly = monthlyAmount(fields, payable);

    const acknowledgement = includeAcknowledgement
        ? `
        <div style="margin-top:10px;border:1px solid #b7d0e8;border-radius:6px;background:${BOX_BG};padding:10px 12px 12px;">
            <div style="font-size:8px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;color:${NAVY};margin-bottom:6px;">Employee acknowledgement</div>
            <div style="font-size:10px;line-height:1.55;color:${INK};text-align:justify;">
                ${buildAssetLossFineAcknowledgementHtml(fields.employeeName, payable, { valueColor: NAVY })}
            </div>
        </div>`
        : '';

    const signatures = includeSignatures
        ? `
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:separate;margin-top:10px;">
            <tr>
                ${sigCard('Employee signature', signatureUrls?.employee)}
                ${sigCard('HOD signature', signatureUrls?.hod)}
                ${sigCard('HR officer', signatureUrls?.hr)}
                ${sigCard('Accounts', signatureUrls?.accounts, { last: true })}
            </tr>
        </table>`
        : '';

    const footer = includeFooter
        ? `
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;margin-top:10px;">
            <tr>
                <td style="font-size:8px;color:${MUTED};">Document reference: ${esc(fineId)}</td>
                <td style="font-size:8px;color:${MUTED};text-align:right;">Confidential - Internal Use</td>
            </tr>
        </table>`
        : '';

    return `
    <div style="width:100%;font-family:Arial,Helvetica,sans-serif;color:${INK};">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;border-radius:6px;overflow:hidden;">
            <tr>
                <td width="6" style="width:6px;background:${TEAL};font-size:0;line-height:0;">&nbsp;</td>
                <td style="background:${NAVY};padding:11px 14px 12px;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;">
                        <tr>
                            <td valign="middle">
                                <div style="font-size:16px;font-weight:bold;letter-spacing:0.06em;color:#ffffff;line-height:1.2;">${esc(title)}</div>
                                <div style="font-size:9px;color:#ffffff;margin-top:4px;opacity:0.95;">Employee payroll deduction authorization</div>
                            </td>
                            <td width="118" valign="middle" align="right" style="width:118px;text-align:right;">
                                <div style="display:inline-block;border:1px solid #ffffff;background:#ffffff;color:${NAVY};padding:5px 10px;border-radius:4px;font-size:8px;font-weight:bold;letter-spacing:0.08em;">${esc(category)}</div>
                            </td>
                        </tr>
                    </table>
                </td>
            </tr>
        </table>

        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:separate;margin-top:10px;">
            ${pairCards('Fine number', esc(fineId), 'Report date', esc(fields.reportDate), { leftAccent: true })}
            ${pairCards('Employee', esc(fields.employeeName), 'Head of department', esc(fields.hodName))}
        </table>

        <div style="margin:2px 0 10px;">
            ${descriptionBox(fields.description)}
        </div>

        <div style="font-size:8px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED};margin:0 0 6px;">Deduction details</div>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;">
            ${moneyRow('Total fine', money(fields.actualFineAmount), 'Service charge', money(fields.serviceCharge))}
            ${moneyRow('Discount', money(fields.discount), 'Total payable fine', money(fields.totalFine))}
            <tr>
                <td style="${tableLabel()}">Payable type</td>
                <td style="${tableValue()}">${esc(fields.payableTypeLabel)}</td>
                <td style="${tableLabel()}">&nbsp;</td>
                <td style="${tableValue()}">&nbsp;</td>
            </tr>
        </table>

        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;margin-top:8px;background:${NAVY};border-radius:6px;">
            <tr>
                <td style="padding:10px 14px;font-size:11px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;color:#ffffff;">Total payable fine</td>
                <td align="right" style="padding:10px 14px;text-align:right;font-size:13px;font-weight:bold;letter-spacing:0.04em;color:#ffffff;">AED ${esc(formatMoney(fields.totalFine))}</td>
            </tr>
        </table>

        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;margin-top:8px;">
            ${moneyRow('Amount deduction per month', money(monthly), 'Source of deduction', fields.sourceOfDeduction)}
            ${moneyRow('Deduction start date', fields.deductionStart, 'Deduction end date', fields.deductionEnd)}
        </table>

        ${acknowledgement}
        ${signatures}
        ${footer}
    </div>`;
}
