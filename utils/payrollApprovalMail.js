const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

function money(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

export function payrollMonthLabel(monthKey) {
    const match = String(monthKey || '').match(/^(\d{4})-(\d{2})$/);
    if (!match) return String(monthKey || '').trim();
    return `${MONTHS[Number(match[2]) - 1] || match[2]} ${match[1]}`;
}

export function formatPayrollAed(value) {
    return `AED ${money(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatPayrollHours(value) {
    const n = money(value);
    const text = Number.isInteger(n)
        ? String(n)
        : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    return `${text} ${n === 1 ? 'hour' : 'hours'}`;
}

export function formatPayrollApprovalWhen(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (!value || Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Dubai',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
    }).format(date);
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Excel deduction columns: fine, advance, loan, and other. Loss of pay is already out of gross. */
export function payrollSheetDeductions(figures) {
    return money(
        money(figures?.fineAmount)
        + money(figures?.advanceAmount)
        + money(figures?.loanAmount)
        + money(figures?.sheetOtherDeduction),
    );
}

export function payrollApprovalRow(figures, companyName) {
    const company = String(companyName || '').trim();
    return {
        companyName: company && company !== '—' ? company : 'Unassigned',
        gross: money(figures?.zohoSalary),
        deductions: payrollSheetDeductions(figures),
        overtimeHours: money(figures?.overtimeHours),
        otAmount: money(figures?.ot),
        otherEarnings: money(figures?.rewardAdditions),
        net: money(figures?.actualSalary),
    };
}

function addMoney(target, row, employees) {
    target.employees += employees;
    target.gross = money(target.gross + row.gross);
    target.deductions = money(target.deductions + row.deductions);
    target.overtimeHours = money(target.overtimeHours + row.overtimeHours);
    target.otAmount = money(target.otAmount + row.otAmount);
    target.otherEarnings = money(target.otherEarnings + row.otherEarnings);
    target.net = money(target.net + row.net);
}

/** Company rows and grand totals use the same fields as the downloaded payroll Excel. */
export function summarizePayrollApproval(rows) {
    const byCompany = new Map();
    for (const row of rows || []) {
        const name = String(row?.companyName || '').trim() || 'Unassigned';
        const key = name.toLowerCase();
        if (!byCompany.has(key)) {
            byCompany.set(key, {
                companyName: name,
                employees: 0,
                gross: 0,
                deductions: 0,
                overtimeHours: 0,
                otAmount: 0,
                otherEarnings: 0,
                net: 0,
            });
        }
        addMoney(byCompany.get(key), row, 1);
    }
    const companies = [...byCompany.values()].sort((a, b) => a.companyName.localeCompare(b.companyName));
    const totals = {
        employees: 0,
        gross: 0,
        deductions: 0,
        overtimeHours: 0,
        otAmount: 0,
        otherEarnings: 0,
        net: 0,
    };
    for (const company of companies) addMoney(totals, company, company.employees);
    return {
        employeeCount: totals.employees,
        companyCount: companies.length,
        companies,
        gross: totals.gross,
        deductions: totals.deductions,
        overtimeHours: totals.overtimeHours,
        otAmount: totals.otAmount,
        otherEarnings: totals.otherEarnings,
        net: totals.net,
    };
}

export function buildSlotAccountsEmailHtml({ slotNo, monthKey, monthLabel, method, attached, payrollUrl }) {
    const label = String(monthLabel || payrollMonthLabel(monthKey) || '').trim();
    const slot = String(slotNo || '').trim() || '1';
    const cash = String(method || '').trim().toUpperCase() === 'CASH';
    const title = cash ? 'Payroll Processing – Cash Salary' : 'Payroll Processing – WPS File';
    const slotTitle = `Salary Slot ${slot} for ${label}`;
    const fileLine = cash
        ? (attached
            ? 'The cash salary workbook for the employees in this slot is attached.'
            : 'The workbook could not be attached to this email. Open the slot workflow and download it there.')
        : (attached
            ? 'Here is the attachment to update your WPS and proceed in VERP for the further process.'
            : 'The WPS workbook could not be attached. Open the payroll details and download it there.');
    const nextLine = cash
        ? 'Open the slot and choose Update payment. That sends the expense to Zoho.'
        : '';
    const detailsUrl = !cash ? String(payrollUrl || '').trim() : '';
    const detailsLink = detailsUrl
        ? `<p style="margin:0 0 12px;"><a href="${escapeHtml(detailsUrl)}">Open the payroll details</a></p>`
        : '';
    return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#ffffff;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="padding:16px 8px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:#0f172a;">
<p style="margin:0 0 12px;">Dear Accounts Team,</p>
<p style="margin:0 0 12px;"><strong>${escapeHtml(title)}</strong></p>
<p style="margin:0 0 12px;">This is to formally notify you that HR has approved <strong>${escapeHtml(slotTitle)}</strong>.</p>
<p style="margin:0 0 12px;">${escapeHtml(fileLine)}</p>
${nextLine ? `<p style="margin:0 0 12px;">${escapeHtml(nextLine)}</p>` : ''}
${detailsLink}
<p style="margin:0 0 12px;">Best regards,</p>
<p style="margin:0;"><strong>VERP HRM – Automated Payroll Management System</strong><br/>VEGA Digital IT Solutions LLC</p>
<p style="margin:16px 0 0;font-size:13px;color:#475569;"><em>This is an automated system-generated notification. Please do not reply to this email.</em></p>
</td></tr>
</table>
</body>
</html>`;
}

export function buildSlotHrApprovalEmailHtml({ slotNo, monthKey, monthLabel }) {
    const label = String(monthLabel || payrollMonthLabel(monthKey) || '').trim();
    const slot = String(slotNo || '').trim() || '1';
    const slotTitle = `Salary Slot ${slot} for ${label}`;
    return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#ffffff;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="padding:16px 8px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:#0f172a;">
<p style="margin:0 0 12px;">Dear HR Team,</p>
<p style="margin:0 0 12px;"><strong>Payroll Processing – Request for HR Approval</strong></p>
<p style="margin:0 0 12px;">This is to formally notify you that <strong>${escapeHtml(slotTitle)}</strong> has been submitted by the Accounts Department and is currently awaiting HR review and approval.</p>
<p style="margin:0 0 12px;">Kindly review the payroll details, verify the relevant salary calculations.</p>
<p style="margin:0 0 12px;">Your timely review and approval will help ensure that the payroll is processed according to the scheduled timeline.</p>
<p style="margin:0 0 12px;">Best regards,</p>
<p style="margin:0;"><strong>VERP HRM – Automated Payroll Management System</strong><br/>VEGA Digital IT Solutions LLC</p>
<p style="margin:16px 0 0;font-size:13px;color:#475569;"><em>This is an automated system-generated notification. Please do not reply to this email.</em></p>
</td></tr>
</table>
</body>
</html>`;
}

export function buildAccountsPayrollApprovedEmailHtml({ monthLabel }) {
    const label = String(monthLabel || '').trim();
    return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#ffffff;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="padding:16px 8px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:#0f172a;">
<p style="margin:0 0 12px;">Dear Accounts Team,</p>
<p style="margin:0 0 12px;">The Management Department has completed payroll checking for <strong>${escapeHtml(label)}</strong> and submitted the payroll.</p>
<p style="margin:0;">Please find the payroll attachment below.</p>
</td></tr>
</table>
</body>
</html>`;
}

export function payrollApprovalSubject(stage, monthLabel) {
    const status = stage === 'MANAGEMENT' ? 'Pending Management Approval' : 'Pending HR Approval';
    return `Payroll Approval Request – ${monthLabel} – ${status}`;
}

function actionUrl(baseUrl, monthKey, stage, action) {
    const root = String(baseUrl || '').replace(/\/+$/, '');
    const stageParam = stage === 'MANAGEMENT' ? 'management' : 'hr';
    return `${root}/HRM/Salary/${encodeURIComponent(monthKey)}?payrollStage=${stageParam}&payrollAction=${action}`;
}

function summaryRows(monthLabel, summary) {
    const rows = [
        ['Salary Month', monthLabel],
        ['Total Employees', String(summary.employeeCount)],
        ['Total Companies', String(summary.companyCount)],
    ];
    for (const company of summary.companies) {
        rows.push([company.companyName, formatPayrollAed(company.net)]);
    }
    rows.push(
        ['Gross Salary', formatPayrollAed(summary.gross)],
        ['Total Deductions', formatPayrollAed(summary.deductions)],
        ['Total Approved OT Hours', formatPayrollHours(summary.overtimeHours)],
        ['Total Approved OT Amount', formatPayrollAed(summary.otAmount)],
        ['Other Earnings', formatPayrollAed(summary.otherEarnings)],
        ['Net Payroll Amount', formatPayrollAed(summary.net)],
    );
    return rows;
}

function cell(text, { header = false, bold = false, align = 'left', shade = '' } = {}) {
    const weight = header || bold ? 'font-weight:700;' : 'font-weight:400;';
    const color = header ? 'color:#ffffff;' : 'color:#0f172a;';
    const background = shade || (header ? '#0f172a' : '#ffffff');
    return `<td style="border:1px solid #e2e8f0;padding:8px 10px;${weight}${color}background:${background};text-align:${align};font-size:14px;line-height:20px;font-family:Arial,Helvetica,sans-serif;">${escapeHtml(text)}</td>`;
}

function button(href, label, color) {
    return `<td bgcolor="${color}" style="border-radius:6px;background:${color};">
        <a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 18px;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;text-decoration:none;">${escapeHtml(label)}</a>
    </td>`;
}

export function buildPayrollApprovalEmailHtml({
    stage,
    monthKey,
    monthLabel,
    summary,
    hrApproverName = '',
    hrApprovedAt = '',
    returnReason = '',
    baseUrl,
}) {
    const management = stage === 'MANAGEMENT';
    const label = monthLabel || payrollMonthLabel(monthKey);
    const status = management ? 'Pending Management Approval' : 'Pending HR Approval';
    const returned = String(returnReason || '').trim();
    const intro = management
        ? `<p style="margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:#0f172a;">Dear Management,</p>
           <p style="margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:#0f172a;">The payroll for <strong>${escapeHtml(label)}</strong> has been reviewed and approved by HR and is now submitted for your final review and approval.</p>
           <p style="margin:0 0 8px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:#0f172a;"><strong>HR Approved By:</strong> ${escapeHtml(hrApproverName || 'HR')}</p>
           <p style="margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:#0f172a;"><strong>HR Approval Date:</strong> ${escapeHtml(hrApprovedAt || '—')}</p>
           <p style="margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:#0f172a;">Please find the payroll summary below.</p>`
        : `<p style="margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:#0f172a;">Dear HR Team,</p>
           ${returned
               ? `<p style="margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:#0f172a;">Management returned <strong>${escapeHtml(label)}</strong> payroll to HR.</p>
                  <p style="margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:#0f172a;"><strong>Reason:</strong> ${escapeHtml(returned)}</p>`
               : `<p style="margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:#0f172a;">The Accounts Department has completed payroll checking for <strong>${escapeHtml(label)}</strong> and submitted the payroll for your review and approval.</p>`}
           <p style="margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:#0f172a;">Please find the payroll summary below.</p>`;
    const pairs = summaryRows(label, summary);
    const summaryHtml = pairs
        .map(([name, value], index) => {
            const shade = index % 2 === 0 ? '#f8fafc' : '#ffffff';
            const last = index === pairs.length - 1;
            return `<tr>${cell(name, { bold: last, shade })}${cell(value, { bold: last, align: 'right', shade })}</tr>`;
        })
        .join('');
    const companyBody = summary.companies.map((company) => (
        `<tr>${cell(company.companyName)}${cell(String(company.employees), { align: 'right' })}${cell(formatPayrollAed(company.gross), { align: 'right' })}${cell(formatPayrollAed(company.deductions), { align: 'right' })}${cell(formatPayrollAed(company.otAmount), { align: 'right' })}${cell(formatPayrollAed(company.net), { align: 'right' })}</tr>`
    )).join('');
    const approveHref = actionUrl(baseUrl, monthKey, stage, 'approve');
    const rejectHref = actionUrl(baseUrl, monthKey, stage, 'reject');
    return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f4f6f8;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f6f8;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:640px;background:#ffffff;border:1px solid #e2e8f0;">
<tr><td style="padding:24px 24px 8px;font-family:Arial,Helvetica,sans-serif;">
<p style="margin:0 0 8px;font-size:12px;letter-spacing:0.04em;color:#64748b;">PAYROLL APPROVAL</p>
<p style="margin:0 0 16px;display:inline-block;background:#eff6ff;color:#1d4ed8;font-size:13px;font-weight:700;padding:6px 10px;">${escapeHtml(status)}</p>
${intro}
</td></tr>
<tr><td style="padding:0 24px 8px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
<tr>${cell('Description', { header: true })}${cell('Value', { header: true, align: 'right' })}</tr>
${summaryHtml}
</table>
</td></tr>
<tr><td style="padding:16px 24px 8px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:700;color:#0f172a;">Company-wise payroll</td></tr>
<tr><td style="padding:0 24px 8px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
<tr>${cell('Company', { header: true })}${cell('Employees', { header: true, align: 'right' })}${cell('Gross Salary', { header: true, align: 'right' })}${cell('Deductions', { header: true, align: 'right' })}${cell('OT Amount', { header: true, align: 'right' })}${cell('Net Salary', { header: true, align: 'right' })}</tr>
${companyBody}
<tr>${cell('Grand Total', { bold: true, shade: '#ecfdf5' })}${cell(String(summary.employeeCount), { bold: true, align: 'right', shade: '#ecfdf5' })}${cell(formatPayrollAed(summary.gross), { bold: true, align: 'right', shade: '#ecfdf5' })}${cell(formatPayrollAed(summary.deductions), { bold: true, align: 'right', shade: '#ecfdf5' })}${cell(formatPayrollAed(summary.otAmount), { bold: true, align: 'right', shade: '#ecfdf5' })}${cell(formatPayrollAed(summary.net), { bold: true, align: 'right', shade: '#ecfdf5' })}</tr>
</table>
</td></tr>
<tr><td style="padding:20px 24px 8px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0">
<tr>
${button(approveHref, 'APPROVE PAYROLL', '#15803d')}
<td width="12" style="width:12px;font-size:0;line-height:0;">&nbsp;</td>
${button(rejectHref, 'REJECT PAYROLL', '#b91c1c')}
</tr>
</table>
</td></tr>
<tr><td style="padding:8px 24px 24px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#475569;">
Sign in to VERP and confirm on the ${escapeHtml(label)} payroll page. Rejecting requires a reason. These links do not approve or reject the payroll by themselves.
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
