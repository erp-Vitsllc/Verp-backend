import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VEGA_LOGO_PATH = path.join(__dirname, '../assets/salary-slip/vega_logo.png');

export const SALARY_SLIP_PDF_SELECTOR = '#salary-slip-pdf[data-ready="true"]';

const NAVY = '#173F6B';
const TEAL = '#10AAA7';
const MUTED = '#64768D';
const HEADER_BLUE_GREY = '#6B8499';
const HEADER_GREY = '#8FA3B5';
const LINE = '#CBD8E5';
const LABEL_BG = '#EEF4F9';
const EARN_TINT = '#E8F7F6';
const DED_TINT = '#FFF7E8';
const BOX_BODY = '#F5F7FA';
const PAGE_W = '210mm';
const PAGE_H = '297mm';

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
    return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function moneyAed(value) {
    return `AED ${money(value)}`;
}

export function getVegaLogoDataUrl() {
    if (!fs.existsSync(VEGA_LOGO_PATH)) return '';
    const b64 = fs.readFileSync(VEGA_LOGO_PATH).toString('base64');
    return `data:image/png;base64,${b64}`;
}

function padRows(left, right, min = 9) {
    const a = Array.isArray(left) ? [...left] : [];
    const b = Array.isArray(right) ? [...right] : [];
    const len = Math.max(a.length, b.length, min);
    while (a.length < len) a.push({ component: '', basis: '', amount: null });
    while (b.length < len) b.push({ component: '', basis: '', amount: null });
    return { left: a, right: b };
}

function headerBar({ logoDataUrl, companyName, companyLocation }) {
    const logo = logoDataUrl
        ? `<img src="${esc(logoDataUrl)}" alt="VEGA Digital" style="display:block;height:13.2mm;width:auto;max-width:72mm;object-fit:contain;" />`
        : `<div style="font-size:16px;font-weight:700;color:${NAVY};letter-spacing:0.12em;">VEGA</div>`;
    return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 8px;">
        <tr>
          <td valign="middle" style="padding:0;width:58%;">${logo}</td>
          <td valign="middle" style="padding:0;width:42%;text-align:right;">
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;color:${HEADER_BLUE_GREY};letter-spacing:0.04em;line-height:1.3;">${esc(companyName)}</div>
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:11.5px;font-weight:600;color:${HEADER_GREY};margin-top:3px;letter-spacing:0.02em;line-height:1.3;">Payroll &amp; Human Resources  |  ${esc(companyLocation)}</div>
          </td>
        </tr>
      </table>`;
}

function sectionTitle(text) {
    return `<div style="background:${NAVY};color:#ffffff;font-size:10px;font-weight:700;letter-spacing:0.14em;padding:7px 10px;margin:10px 0 0;">${esc(text)}</div>`;
}

function summaryLabel(text) {
    const empty = !text;
    return `<td class="p1-lbl" width="18%">${empty ? '&nbsp;' : esc(text)}</td>`;
}

function summaryValue(text) {
    const empty = !text;
    return `<td class="p1-val" width="32%">${empty ? '&nbsp;' : esc(text)}</td>`;
}

function summaryRow(l1, v1, l2, v2) {
    return `<tr>${summaryLabel(l1)}${summaryValue(v1)}${summaryLabel(l2)}${summaryValue(v2)}</tr>`;
}

function th(text, align = 'left') {
    return `<th style="padding:6px 7px;border:1px solid ${LINE};background:${NAVY};color:#ffffff;font-size:9px;font-weight:700;text-align:${align};">${esc(text)}</th>`;
}

function td(text, { align = 'left', bold = false, empty = false } = {}) {
    const color = empty ? '#ffffff' : NAVY;
    return `<td style="padding:5px 7px;border:1px solid ${LINE};font-size:9.5px;color:${color};font-weight:${bold ? 700 : 500};text-align:${align};background:#ffffff;">${empty ? '&nbsp;' : esc(text)}</td>`;
}

function calcCell(text, { align = 'left', color = NAVY, bold = false, empty = false, width } = {}) {
    const w = width ? `width="${width}"` : '';
    return `<td ${w} style="padding:5px 7px;border:1px solid ${LINE};background:#ffffff;font-size:9.5px;line-height:1.25;color:${empty ? '#ffffff' : color};font-weight:${bold ? 700 : 500};text-align:${align};">${empty ? '&nbsp;' : esc(text)}</td>`;
}

function pageFooter(page, total) {
    return `
      <div class="slip-footer">
        <span>Confidential payroll document</span>
        <span>Page ${page} of ${total}</span>
      </div>`;
}

function approvalBox(role, title) {
    return `
      <td width="25%" valign="top" style="padding:6px 8px;border:1px solid ${LINE};">
        <div style="font-size:8.5px;font-weight:700;letter-spacing:0.08em;color:${MUTED};">${esc(role)}</div>
        <div style="font-size:11.5px;font-weight:700;color:${NAVY};margin:4px 0 18px;">${esc(title)}</div>
        <div style="font-size:9.5px;color:${MUTED};border-top:1px solid ${LINE};padding-top:6px;">Signature</div>
        <div style="font-size:9.5px;color:${MUTED};margin-top:10px;">Date: __________________</div>
      </td>`;
}

function tableRows(headers, bodyHtml) {
    return `
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:0;">
        <tr>${headers}</tr>
        ${bodyHtml}
      </table>`;
}

/**
 * VEGA monthly salary slip — page 1 matches VEGA_Monthly_Salary_Slip_Sample.
 */
export function buildSalarySlipPdfHtml(slip = {}) {
    const logoDataUrl = slip.logoDataUrl || getVegaLogoDataUrl();
    const companyName = slip.companyName || 'VEGA DIGITAL IT SOLUTIONS LLC';
    const companyLocation = slip.companyLocation || 'Dubai, UAE';
    const att = slip.attendance || {};
    const { left: earnRows, right: dedRows } = padRows(slip.earnings, slip.deductions, 9);
    const calcRows = earnRows
        .map((earn, i) => {
            const ded = dedRows[i] || {};
            const earnEmpty = !earn.component;
            const dedEmpty = !ded.component;
            return `<tr>
              ${calcCell(earn.component, { empty: earnEmpty, width: '23%' })}
              ${calcCell(earn.basis, { empty: earnEmpty, align: 'center', width: '9%' })}
              ${calcCell(earnEmpty ? '' : money(earn.amount), { empty: earnEmpty, align: 'right', color: TEAL, bold: true, width: '18%' })}
              ${calcCell(ded.component, { empty: dedEmpty, width: '23%' })}
              ${calcCell(ded.basis, { empty: dedEmpty, align: 'center', width: '9%' })}
              ${calcCell(dedEmpty ? '' : money(ded.amount), { empty: dedEmpty, align: 'right', color: NAVY, bold: true, width: '18%' })}
            </tr>`;
        })
        .join('');

    const attDedRows = (slip.attendanceDeductions || [])
        .map((row) => `<tr>
          ${td(row.category)}
          ${td(row.qty)}
          ${td(row.rate)}
          ${td(row.calculation)}
          ${td(money(row.total), { align: 'right', bold: true })}
        </tr>`)
        .join('');

    const loanRows = (slip.loanSchedule || [])
        .map((row) => `<tr>
          ${td(row.type)}
          ${td(row.original)}
          ${td(row.thisMonth)}
          ${td(row.paidToDate)}
          ${td(row.remaining)}
          ${td(row.schedule)}
        </tr>`)
        .join('');

    const fineRows = (slip.fines || [])
        .map((row) => `<tr>
          ${td(row.type)}
          ${td(row.amount)}
          ${td(row.schedule)}
          ${td(row.thisMonth)}
          ${td(row.paid)}
          ${td(row.unpaidStatus)}
        </tr>`)
        .join('');

    const utilRows = (slip.utilities || [])
        .map((row) => `<tr>
          ${td(row.details)}
          ${td(row.amount)}
          ${td(row.reason)}
          ${td(money(row.total), { align: 'right', bold: true })}
        </tr>`)
        .join('');

    const recon = slip.reconciliation || {};
    const approvers = slip.approvers || [
        { role: 'CREATED BY', title: 'Payroll Officer' },
        { role: 'APPROVED BY', title: 'HR Manager' },
        { role: 'AUTHORIZED BY', title: 'General Manager' },
        { role: 'RECEIVED BY', title: 'Employee' },
    ];
    const header = headerBar({ logoDataUrl, companyName, companyLocation });

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Salary slip — ${esc(slip.employeeId)} — ${esc(slip.monthLabel)}</title>
<style>
  @page { size: A4 portrait; margin: 0; }
  html, body { margin: 0; padding: 0; background: #ffffff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  #salary-slip-pdf, #salary-slip-pdf * { box-sizing: border-box; }
  #salary-slip-pdf {
    width: ${PAGE_W};
    margin: 0 auto;
    font-family: Arial, Helvetica, sans-serif;
    color: ${NAVY};
    background: #ffffff;
  }
  .slip-page {
    position: relative;
    width: ${PAGE_W};
    min-height: ${PAGE_H};
    padding: 11mm 13mm 16mm;
    page-break-after: always;
    break-after: page;
  }
  .slip-page:last-child {
    page-break-after: auto;
    break-after: auto;
  }
  .slip-footer {
    position: absolute;
    left: 13mm;
    right: 13mm;
    bottom: 7mm;
    display: flex;
    justify-content: space-between;
    font-size: 8.5px;
    color: ${MUTED};
    border-top: 0.5pt solid ${LINE};
    padding-top: 4px;
  }
  .p1-title {
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    margin: 2px 0 0;
  }
  .p1-title td { vertical-align: middle; }
  .p1-title-main {
    background: ${NAVY};
    color: #ffffff;
    font-size: 17px;
    font-weight: 700;
    letter-spacing: 0.08em;
    padding: 9px 14px;
    line-height: 1.15;
  }
  .p1-title-sample {
    width: 28%;
    background: #ffffff;
    color: ${NAVY};
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-align: center;
    padding: 8px 8px;
    border: 2px solid ${TEAL};
    white-space: nowrap;
  }
  .p1-meta {
    text-align: right;
    font-size: 13px;
    font-weight: 600;
    color: ${MUTED};
    padding: 7px 0 3px;
  }
  .p1-summary {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
  }
  .p1-lbl {
    background: ${LABEL_BG};
    color: ${MUTED};
    font-size: 8px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 7px 8px;
    border: 0.6pt solid ${LINE};
    vertical-align: middle;
    line-height: 1.3;
  }
  .p1-val {
    background: #ffffff;
    color: ${NAVY};
    font-size: 11px;
    font-weight: 700;
    padding: 7px 8px;
    border: 0.6pt solid ${LINE};
    vertical-align: middle;
    line-height: 1.25;
  }
  .p1-colh {
    font-size: 8px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: ${MUTED};
    padding: 5px 6px;
    border: 0.6pt solid ${LINE};
    line-height: 1.2;
  }
  .p1-box-h {
    color: #ffffff;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-align: center;
    padding: 7px 8px;
  }
  .p1-box-b {
    background: ${BOX_BODY};
    text-align: center;
    padding: 10px 8px 12px;
  }
</style>
</head>
<body>
  <div id="salary-slip-pdf" data-ready="true">
    <div class="slip-page">
      ${header}
      <table class="p1-title" cellpadding="0" cellspacing="0">
        <tr>
          <td class="p1-title-main">MONTHLY SALARY SLIP</td>
          <td class="p1-title-sample">${esc(slip.employeeId || '—')}</td>
        </tr>
      </table>
      <div class="p1-meta">Salary Month: ${esc(slip.monthLabel || '—')} &nbsp;|&nbsp; Slip Ref: ${esc(slip.slipRef || '—')}</div>
      ${sectionTitle('EMPLOYEE & ATTENDANCE SUMMARY')}
      <table class="p1-summary" cellpadding="0" cellspacing="0">
        ${summaryRow('Employee Name', slip.employeeName, 'Holidays', att.holidays)}
        ${summaryRow('Employee ID', slip.employeeId, 'Working Day Leaves', att.workingDayLeaves)}
        ${summaryRow('Designation', slip.designation, 'Present Days', att.presentDays)}
        ${summaryRow('Salary Month', slip.monthLabel, 'Holidays Worked', att.holidaysWorked)}
        ${summaryRow('Calendar Days', att.calendarDays, 'Overtime Hours', att.overtimeHours)}
        ${summaryRow('', '', 'Comp Off Leave', att.compOffLeave)}
      </table>
      ${sectionTitle('SALARY CALCULATION')}
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed;">
        <tr>
          <th colspan="3" style="padding:7px 8px;border:0.6pt solid ${LINE};background:${TEAL};color:#ffffff;font-size:11px;font-weight:700;letter-spacing:0.14em;text-align:center;">EARNINGS</th>
          <th colspan="3" style="padding:7px 8px;border:0.6pt solid ${LINE};background:${NAVY};color:#ffffff;font-size:11px;font-weight:700;letter-spacing:0.14em;text-align:center;">DEDUCTIONS</th>
        </tr>
        <tr>
          <th class="p1-colh" style="background:${EARN_TINT};text-align:left;">Component</th>
          <th class="p1-colh" style="background:${EARN_TINT};text-align:center;">Basis</th>
          <th class="p1-colh" style="background:${EARN_TINT};text-align:right;">Amount (AED)</th>
          <th class="p1-colh" style="background:${LABEL_BG};text-align:left;">Component</th>
          <th class="p1-colh" style="background:${LABEL_BG};text-align:center;">Basis</th>
          <th class="p1-colh" style="background:${LABEL_BG};text-align:right;">Amount (AED)</th>
        </tr>
        ${calcRows}
        <tr>
          <td colspan="2" style="padding:6px 8px;border:0.6pt solid ${LINE};background:${EARN_TINT};font-size:9.5px;font-weight:700;letter-spacing:0.06em;color:${TEAL};">GROSS EARNINGS</td>
          <td style="padding:6px 8px;border:0.6pt solid ${LINE};background:${EARN_TINT};font-size:10px;font-weight:700;color:${TEAL};text-align:right;">${esc(money(slip.grossEarnings))}</td>
          <td colspan="2" style="padding:6px 8px;border:0.6pt solid ${LINE};background:${DED_TINT};font-size:9.5px;font-weight:700;letter-spacing:0.06em;color:${NAVY};">TOTAL DEDUCTIONS</td>
          <td style="padding:6px 8px;border:0.6pt solid ${LINE};background:${DED_TINT};font-size:10px;font-weight:700;color:${NAVY};text-align:right;">${esc(money(slip.totalDeductions))}</td>
        </tr>
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:8px;">
        <tr>
          <td class="p1-box-h" style="background:${TEAL};border:0.6pt solid ${LINE};width:33.33%;">GROSS EARNINGS</td>
          <td class="p1-box-h" style="background:${NAVY};border:0.6pt solid ${LINE};width:33.33%;">TOTAL DEDUCTIONS</td>
          <td class="p1-box-h" style="background:${TEAL};border:0.6pt solid ${LINE};width:33.34%;">NET SALARY</td>
        </tr>
        <tr>
          <td class="p1-box-b" style="border:0.6pt solid ${LINE};">
            <div style="font-size:15px;font-weight:700;color:${TEAL};letter-spacing:0.01em;">${esc(moneyAed(slip.grossEarnings))}</div>
          </td>
          <td class="p1-box-b" style="border:0.6pt solid ${LINE};">
            <div style="font-size:15px;font-weight:700;color:${NAVY};letter-spacing:0.01em;">${esc(moneyAed(slip.totalDeductions))}</div>
          </td>
          <td class="p1-box-b" style="border:0.6pt solid ${LINE};">
            <div style="font-size:17px;font-weight:700;color:${TEAL};letter-spacing:0.01em;">${esc(moneyAed(slip.netSalary))}</div>
          </td>
        </tr>
        <tr>
          <td colspan="3" style="border:0.6pt solid ${LINE};background:${LABEL_BG};padding:10px 12px;">
            <span style="color:${MUTED};font-size:10px;font-weight:700;letter-spacing:0.08em;">AMOUNT IN WORDS:</span>
            <span style="display:inline-block;margin-left:8px;font-size:13px;font-weight:700;color:${NAVY};line-height:1.35;">${esc(slip.amountInWords || '—')}</span>
          </td>
        </tr>
      </table>
      <p style="margin:7px 0 0;font-size:10px;color:${TEAL};font-weight:700;">
        Payment Method: ${esc(slip.paymentMethod || 'Bank Transfer')}
        &nbsp;|&nbsp; Payment Date: ${esc(slip.paymentDate || '—')}
        &nbsp;|&nbsp; Currency: ${esc(slip.currency || 'AED')}
      </p>
      ${pageFooter(1, 2)}
    </div>

    <div class="slip-page">
      ${header}
      ${sectionTitle('DEDUCTION DETAILS SUMMARY')}
      <p style="margin:6px 0 8px;font-size:10px;color:${MUTED};">
        Employee: ${esc(slip.employeeName)} &nbsp;|&nbsp; Employee ID: ${esc(slip.employeeId)} &nbsp;|&nbsp; Salary Month: ${esc(slip.monthLabel)}
      </p>
      <div style="font-size:10px;font-weight:700;color:${NAVY};margin:8px 0 4px;">A. ATTENDANCE-BASED DEDUCTIONS</div>
      ${tableRows(
          `${th('Category')}${th('Qty')}${th('Rate / Unit')}${th('Calculation / Reason')}${th('Total (AED)', 'right')}`,
          `${attDedRows}
           <tr>
             <td colspan="4" style="padding:5px 6px;border:1px solid ${LINE};background:${EARN_TINT};font-size:9.5px;font-weight:700;color:${NAVY};">ATTENDANCE DEDUCTION TOTAL</td>
             <td style="padding:5px 6px;border:1px solid ${LINE};background:${EARN_TINT};font-size:9.5px;font-weight:700;color:${NAVY};text-align:right;">${esc(money(slip.attendanceDeductionTotal))}</td>
           </tr>`,
      )}
      <div style="font-size:10px;font-weight:700;color:${NAVY};margin:12px 0 4px;">B. SALARY ADVANCE &amp; LOAN SCHEDULE</div>
      ${tableRows(
          `${th('Type')}${th('Original Amount')}${th('This Month')}${th('Paid to Date')}${th('Remaining')}${th('Deduction Schedule')}`,
          loanRows || `<tr>${td('—')}${td('AED 0.00')}${td('AED 0.00')}${td('AED 0.00')}${td('AED 0.00')}${td('—')}</tr>`,
      )}
      <div style="font-size:10px;font-weight:700;color:${NAVY};margin:12px 0 4px;">C. FINE DETAILS</div>
      ${tableRows(
          `${th('Fine Type')}${th('Fine Amount')}${th('Deduction Schedule')}${th('This Month')}${th('Paid')}${th('Unpaid / Status')}`,
          fineRows || `<tr>${td('—')}${td('AED 0.00')}${td('—')}${td('AED 0.00')}${td('AED 0.00')}${td('—')}</tr>`,
      )}
      <div style="font-size:10px;font-weight:700;color:${NAVY};margin:12px 0 4px;">D. UTILITY EXCESS DETAILS</div>
      ${tableRows(
          `${th('Utility Details')}${th('Amount')}${th('Deduction Reason')}${th('Total (AED)', 'right')}`,
          utilRows || `<tr>${td('—')}${td('AED 0.00')}${td('No utility excess for this month')}${td('0.00', { align: 'right' })}</tr>`,
      )}
      <div style="font-size:10px;font-weight:700;color:${NAVY};margin:12px 0 4px;">E. DEDUCTION RECONCILIATION</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>
          ${th('Attendance')}${th('Salary Advance')}${th('Loan')}${th('Fine')}${th('Utility Excess')}
        </tr>
        <tr>
          ${td(moneyAed(recon.attendance), { align: 'center', bold: true })}
          ${td(moneyAed(recon.salaryAdvance), { align: 'center', bold: true })}
          ${td(moneyAed(recon.loan), { align: 'center', bold: true })}
          ${td(moneyAed(recon.fine), { align: 'center', bold: true })}
          ${td(moneyAed(recon.utilityExcess), { align: 'center', bold: true })}
        </tr>
      </table>
      <p style="margin:8px 0 0;font-size:10px;font-weight:700;color:${NAVY};">
        Verified Total Deductions: ${esc(moneyAed(recon.verifiedTotal ?? slip.totalDeductions))}
      </p>
      ${sectionTitle('APPROVAL & ACKNOWLEDGEMENT')}
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:0;">
        <tr>
          ${approvers.map((row) => approvalBox(row.role, row.title)).join('')}
        </tr>
      </table>
      ${pageFooter(2, 2)}
    </div>
  </div>
</body>
</html>`;
}
