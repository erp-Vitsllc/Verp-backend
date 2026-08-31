import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LETTERHEAD_PNG_PATH = path.join(
    __dirname,
    '../assets/letterhead/vits_letterhead_abudhabi.png',
);
const LEGACY_LETTERHEAD_PATH = path.join(__dirname, '../assets/email/fine-form-letterhead.png');

const SAFE_TOP = '36mm';
const SAFE_BOTTOM = '52mm';
const SAFE_X = '18mm';

export const SALARY_SLIP_PDF_SELECTOR = '#salary-slip-pdf[data-ready="true"]';

function esc(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function money(value) {
    const n = Number(value);
    const amount = Number.isFinite(n) ? n : 0;
    return `${amount.toLocaleString('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} AED`;
}

function getLetterheadDataUrl() {
    const filePath = fs.existsSync(LETTERHEAD_PNG_PATH)
        ? LETTERHEAD_PNG_PATH
        : LEGACY_LETTERHEAD_PATH;
    if (!fs.existsSync(filePath)) return '';
    const b64 = fs.readFileSync(filePath).toString('base64');
    const mime = filePath.toLowerCase().endsWith('.jpg') ? 'image/jpeg' : 'image/png';
    return `data:${mime};base64,${b64}`;
}

function row(label, value, { total = false } = {}) {
    const weight = total ? '700' : '500';
    const bg = total ? '#eef6ff' : '#ffffff';
    return `
        <tr>
            <td style="padding:8px 10px;border:1px solid #d5dee8;font-size:12px;color:#1a3e63;font-weight:${weight};background:${bg};">${esc(label)}</td>
            <td style="padding:8px 10px;border:1px solid #d5dee8;font-size:12px;color:#1a3e63;font-weight:${weight};text-align:right;background:${bg};">${esc(value)}</td>
        </tr>`;
}

export function buildSalarySlipPdfHtml({
    monthLabel,
    employeeName,
    employeeId,
    designation,
    companyName,
    earnings = [],
    netSalary,
} = {}) {
    const bgUrl = getLetterheadDataUrl();
    const letterheadLayer = bgUrl
        ? `<div class="vits-slip-letterhead" aria-hidden="true"><img src="${esc(bgUrl)}" alt="" /></div>`
        : '';
    const earningRows = (Array.isArray(earnings) ? earnings : [])
        .filter((item) => Number(item?.amount) > 0 || item?.always)
        .map((item) => row(item.label, money(item.amount)))
        .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Salary slip — ${esc(employeeId)} — ${esc(monthLabel)}</title>
<style>
  @page { size: A4 portrait; margin: ${SAFE_TOP} ${SAFE_X} ${SAFE_BOTTOM}; }
  html, body { margin: 0; padding: 0; background: #ffffff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  #salary-slip-pdf, #salary-slip-pdf * { box-sizing: border-box; }
  #salary-slip-pdf {
    position: relative; width: 100%; margin: 0 auto;
    font-family: Arial, Helvetica, sans-serif; color: #1e293b; line-height: 1.35; background: #ffffff;
  }
  .vits-slip-letterhead {
    position: fixed; top: -${SAFE_TOP}; left: -${SAFE_X}; width: 210mm; height: 297mm; z-index: 0; pointer-events: none; overflow: hidden;
  }
  .vits-slip-letterhead img { display: block; width: 210mm; height: 297mm; object-fit: fill; object-position: center top; }
  .vits-slip-content { position: relative; z-index: 1; width: 100%; }
</style>
</head>
<body>
  <div id="salary-slip-pdf" data-ready="true">
    ${letterheadLayer}
    <div class="vits-slip-content">
      <p style="margin:0 0 4px;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#8aa0b5;font-weight:700;">Payroll</p>
      <h1 style="margin:0 0 18px;font-size:22px;color:#1a3e63;">Salary slip</h1>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
        <tr>
          <td width="50%" valign="top" style="padding:0 8px 8px 0;">
            <div style="font-size:8px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#8aa0b5;margin-bottom:4px;">Employee</div>
            <div style="font-size:14px;font-weight:700;color:#1a3e63;">${esc(employeeName || '—')}</div>
            <div style="font-size:12px;color:#64748b;margin-top:2px;">${esc(employeeId || '—')}</div>
          </td>
          <td width="50%" valign="top" style="padding:0 0 8px 8px;text-align:right;">
            <div style="font-size:8px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#8aa0b5;margin-bottom:4px;">Salary month</div>
            <div style="font-size:14px;font-weight:700;color:#1a3e63;">${esc(monthLabel || '—')}</div>
            <div style="font-size:12px;color:#64748b;margin-top:2px;">${esc(companyName || '—')}</div>
          </td>
        </tr>
      </table>
      ${designation ? `<p style="margin:0 0 14px;font-size:12px;color:#475569;">Designation: <strong>${esc(designation)}</strong></p>` : ''}
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>
          <th style="padding:8px 10px;border:1px solid #d5dee8;background:#1a3e63;color:#ffffff;font-size:11px;text-align:left;">Earnings</th>
          <th style="padding:8px 10px;border:1px solid #d5dee8;background:#1a3e63;color:#ffffff;font-size:11px;text-align:right;">Amount</th>
        </tr>
        ${earningRows || row('Monthly salary', money(netSalary), { total: false })}
        ${row('Net salary', money(netSalary), { total: true })}
      </table>
      <p style="margin:16px 0 0;font-size:11px;color:#64748b;">This slip is issued after payroll approval for ${esc(monthLabel)}.</p>
    </div>
  </div>
</body>
</html>`;
}
