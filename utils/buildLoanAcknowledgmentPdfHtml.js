const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

export function formatMoney(value) {
    return Number(value || 0).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

function esc(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function formatDisplayDate(value) {
    if (!value) return '—';
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
}

function parseMonthYear(value) {
    if (!value || typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}$/.test(trimmed)) {
        const [y, m] = trimmed.split('-').map(Number);
        return { year: y, month: m };
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
        const d = new Date(trimmed);
        if (!Number.isNaN(d.getTime())) {
            return { year: d.getFullYear(), month: d.getMonth() + 1 };
        }
    }
    return null;
}

export function formatMonthYearLabel(value) {
    const parsed = parseMonthYear(value);
    if (!parsed) return '—';
    const name = MONTH_NAMES[parsed.month - 1] || '';
    return `${name} ${parsed.year}`;
}

export function addMonthsToMonthYear(value, monthsToAdd) {
    const parsed = parseMonthYear(value);
    if (!parsed) return null;
    const d = new Date(parsed.year, parsed.month - 1 + monthsToAdd, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function resolveRepaymentPeriod(loan) {
    const duration = Math.max(1, parseInt(loan?.duration, 10) || 1);
    const startSource = loan?.monthStart || loan?.deductionStartMonth || loan?.appliedDate || loan?.approvedDate;
    const startYm =
        parseMonthYear(startSource)
            ? (typeof startSource === 'string' && /^\d{4}-\d{2}$/.test(startSource.trim())
                ? startSource.trim()
                : (() => {
                    const d = new Date(startSource);
                    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                })())
            : null;
    const endYm = startYm ? addMonthsToMonthYear(startYm, duration - 1) : null;
    return {
        duration,
        startYm,
        endYm,
        startLabel: formatMonthYearLabel(startYm),
        endLabel: formatMonthYearLabel(endYm),
        monthlyAmount: Number(loan?.amount || 0) / duration,
    };
}

function sigImg(sig, minHeight = 56) {
    const url = sig?.url ? esc(sig.url) : '';
    if (url) {
        return `<img src="${url}" alt="" style="max-height:${minHeight}px;max-width:200px;object-fit:contain;display:block;margin:0 auto;" />`;
    }
    return `<div style="min-height:${minHeight}px;border-bottom:1px solid #333;width:180px;margin:0 auto;"></div>`;
}

function workflowApprovedDate(loan, role) {
    const entry = (loan?.workflow || []).find(
        (w) => w.role === role && w.status === 'Approved' && w.actionedAt
    );
    return entry?.actionedAt ? formatDisplayDate(entry.actionedAt) : '—';
}

function borderedCell(content, extraStyle = '') {
    return `<td width="33%" valign="middle" style="padding:10px 8px;border:1px solid #000;text-align:center;font-size:11px;${extraStyle}">${content}</td>`;
}

function buildApproverSignaturesTable(signatureUrls, dates) {
    const cols = [
        { label: 'HOD Signature', sig: signatureUrls?.hod, date: dates.hod },
        { label: 'HR Officer', sig: signatureUrls?.hr, date: dates.hr },
        { label: 'Accounts', sig: signatureUrls?.accounts, date: dates.accounts },
    ];

    const labelRow = cols
        .map((c) => borderedCell(`<div style="font-weight:bold;font-size:12px;">${esc(c.label)}</div>`))
        .join('');
    const dateRow = cols.map((c) => borderedCell(esc(c.date), 'font-size:11px;')).join('');
    const sigRow = cols
        .map((c) =>
            borderedCell(
                `<div style="min-height:72px;display:flex;align-items:center;justify-content:center;">${sigImg(c.sig, 64)}</div>`,
                'vertical-align:middle;'
            )
        )
        .join('');

    return `<p style="margin:24px 0 8px 0;font-size:13px;font-weight:bold;">Office Staff's</p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #000;">
        <tr>${labelRow}</tr>
        <tr>${dateRow}</tr>
        <tr>${sigRow}</tr>
    </table>`;
}

function buildEmployeeClosingSection(employeeName, department, employeeSig, employeeDate) {
    const signatureCell = sigImg(employeeSig, 72);
    return `
    <div style="margin-top:32px;">
        <p style="margin:0 0 18px 0;">Sincerely,</p>
        <p style="margin:0 0 4px 0;font-weight:bold;font-size:13px;">${esc(employeeName)}</p>
        <p style="margin:0 0 14px 0;font-size:13px;">${esc(department || '—')}</p>
    </div>
    <table role="presentation" width="34%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #000;margin-bottom:8px;">
        <tr>
            <td style="padding:12px 10px;border:1px solid #000;text-align:center;vertical-align:middle;min-height:88px;">
                <div style="font-size:10px;color:#444;margin-bottom:8px;">${esc(employeeDate)}</div>
                ${signatureCell}
            </td>
        </tr>
    </table>`;
}

export const LOAN_ACKNOWLEDGMENT_PDF_SELECTOR = '#loan-acknowledgment-pdf[data-loan-ack-ready="true"]';

export function buildLoanAcknowledgmentPdfHtml({
    loan,
    employeeName,
    department,
    emiratesId,
    companyName,
    signatureUrls,
    letterDate,
    receivedDate,
}) {
    const isAdvance = loan?.type === 'Advance';
    const typeLabel = isAdvance ? 'salary advance' : 'loan';
    const typeLabelCap = isAdvance ? 'Salary Advance' : 'Loan';
    const period = resolveRepaymentPeriod(loan);
    const amount = formatMoney(loan?.amount);
    const monthly = formatMoney(period.monthlyAmount);

    const bodyParagraph = `I, <strong>${esc(employeeName)}</strong> holding Employee Emirates ID <strong>${esc(emiratesId || '—')}</strong>, and serving in the position of <strong>${esc(department || '—')}</strong>, hereby formally acknowledge that I have received a ${typeLabel} amount of <strong>AED ${amount}</strong>, from <strong>${esc(companyName)}</strong> on <strong>${esc(receivedDate)}</strong>.`;

    const consentParagraph = `I confirm that I fully understand the terms and conditions associated with this ${typeLabel}. In accordance with the provisions of UAE Labour Law, and through this written declaration, I hereby provide my explicit consent authorizing <strong>${esc(companyName)}</strong> to deduct the ${typeLabel} repayment directly from my monthly salary.`;

    const repaymentIntro = `I further authorize the Company to deduct:`;
    const repaymentDetail = `A monthly repayment amount of <strong>AED ${monthly}</strong>, until the full ${typeLabel} amount has been settled (<strong>${esc(period.startLabel)}</strong> to <strong>${esc(period.endLabel)}</strong>).`;

    const approverDates = {
        hod: loan?.appliedDate ? formatDisplayDate(loan.appliedDate) : '—',
        hr: workflowApprovedDate(loan, 'HR'),
        accounts: workflowApprovedDate(loan, 'Accounts'),
    };

    const employeeDate = loan?.appliedDate ? formatDisplayDate(loan.appliedDate) : letterDate;
    const employeeClosing = buildEmployeeClosingSection(
        employeeName,
        department,
        signatureUrls?.employee,
        employeeDate
    );
    const approverSection = buildApproverSignaturesTable(signatureUrls, approverDates);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${typeLabelCap} Acknowledgment — ${esc(loan?.loanId || '')}</title>
<style>
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
  p { margin: 0 0 14px 0; text-align: justify; line-height: 1.65; font-size: 13px; color: #111; }
  ul { margin: 10px 0 14px 22px; padding: 0; font-size: 13px; line-height: 1.55; }
</style>
</head>
<body style="margin:0;background:#fff;">
<div id="loan-acknowledgment-pdf" data-loan-ack-ready="true" style="box-sizing:border-box;max-width:210mm;margin:0 auto;padding:48px 52px 56px;font-family:Georgia,'Times New Roman',serif;color:#111;line-height:1.55;min-height:297mm;">
    <h1 style="text-align:center;font-size:18px;font-weight:bold;margin:0 0 6px 0;text-transform:none;">${typeLabelCap} Acknowledgment &amp; Salary Deduction Authorization Letter</h1>
    <p style="text-align:left;font-size:13px;margin:18px 0 22px 0;"><strong>Date:</strong> ${esc(letterDate)}</p>

    <p style="font-size:13px;margin-bottom:18px;">
        <strong>To:</strong><br/>
        The Human Resources Department<br/>
        ${esc(companyName)}<br/>
        Dubai, United Arab Emirates
    </p>

    <p style="font-size:13px;font-weight:bold;margin-bottom:18px;">
        Subject: ${typeLabelCap} Acknowledgment and Authorization for Salary Deduction
    </p>

    <p>${bodyParagraph}</p>
    <p>${consentParagraph}</p>
    <p>${repaymentIntro}</p>
    <p>${repaymentDetail}</p>

    <p>Additionally, I agree that any outstanding ${typeLabel} balance at the time of my resignation, termination, or during the processing of my final settlement may be deducted from my:</p>
    <ul>
        <li>Final salary</li>
        <li>Accrued leave encashment</li>
        <li>Gratuity</li>
        <li>End-of-service benefits</li>
    </ul>
    <p>as permitted under UAE Labour Law and Company policy.</p>
    <p>I confirm that this authorization is provided voluntarily, without any form of pressure, and that I understand this document constitutes a binding financial obligation.</p>

    ${employeeClosing}
    ${approverSection}
</div>
</body>
</html>`;
}
