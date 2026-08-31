import nodemailer from 'nodemailer';
import EmployeeBasic from '../models/EmployeeBasic.js';
import EmployeeSalary from '../models/EmployeeSalary.js';
import SalaryEnrollment from '../models/SalaryEnrollment.js';
import SalaryHistoricalProfile from '../models/SalaryHistoricalProfile.js';
import { isCompanyShellEmployee, REAL_EMPLOYEE_MONGO_FILTER } from './attendanceEmployeeFilters.js';
import { isPlaceholderEmployeeId } from './employeeIdPrefix.js';
import { generatePdfFromHtml, pdfOutputToBuffer } from './generatePdf.js';
import {
    buildSalarySlipPdfHtml,
    SALARY_SLIP_PDF_SELECTOR,
} from './buildSalarySlipPdfHtml.js';
import { buildEmailDedupeKey, sendErpEmail } from './emailDispatch.js';

const MONTH_FULL = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

function pad2(n) {
    return String(n).padStart(2, '0');
}

function monthKeyOf(value) {
    const raw = String(value || '').trim();
    if (/^\d{4}-\d{2}$/.test(raw)) return raw;
    const iso = raw.match(/^(\d{4}-\d{2})/);
    return iso ? iso[1] : '';
}

function toYearMonth(value) {
    if (!value) return '';
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}`;
    }
    const raw = String(value).trim();
    if (/^\d{4}-\d{2}$/.test(raw)) return raw;
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 7);
    const named = raw.match(/^([A-Za-z]+)\s+(\d{4})$/);
    if (named) {
        const idx = MONTH_FULL.findIndex((name) => name.toLowerCase() === named[1].toLowerCase());
        if (idx >= 0) return `${named[2]}-${pad2(idx + 1)}`;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

function monthLabel(ym) {
    const match = String(ym || '').match(/^(\d{4})-(\d{2})$/);
    if (!match) return ym || '';
    const name = MONTH_FULL[Number(match[2]) - 1];
    return name ? `${name} ${match[1]}` : ym;
}

function money(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function personName(row) {
    return `${row?.firstName || ''} ${row?.lastName || ''}`.trim() || row?.employeeId || 'Employee';
}

function companyNameOf(emp) {
    const company = emp?.company;
    if (!company) return '';
    if (typeof company === 'string') return company.trim();
    return String(company.nickName || company.name || '').trim();
}

function historyFromMonth(entry) {
    return toYearMonth(entry?.fromDate) || toYearMonth(entry?.month);
}

function historyCoversMonth(entry, ym) {
    const from = historyFromMonth(entry);
    const to = toYearMonth(entry?.toDate);
    if (!from && !to) return false;
    if (from && from > ym) return false;
    if (to && to < ym) return false;
    return true;
}

function historyEntryForMonth(salaryDoc, ym) {
    const history = Array.isArray(salaryDoc?.salaryHistory) ? salaryDoc.salaryHistory : [];
    const matching = history.filter((entry) => historyCoversMonth(entry, ym));
    if (matching.length) {
        matching.sort((a, b) => String(historyFromMonth(b) || '').localeCompare(String(historyFromMonth(a) || '')));
        return matching[0];
    }
    const openRows = history.filter((entry) => !entry?.toDate);
    if (openRows.length) {
        openRows.sort((a, b) => String(historyFromMonth(b) || '').localeCompare(String(historyFromMonth(a) || '')));
        const latestOpen = openRows[0];
        const from = historyFromMonth(latestOpen);
        if (!from || from <= ym) return latestOpen;
    }
    return salaryDoc || null;
}

function salaryEarnings(entry) {
    const extras = Array.isArray(entry?.additionalAllowances) ? entry.additionalAllowances : [];
    const extraHasVehicle = extras.some((row) => String(row?.type || '').toLowerCase().includes('vehicle'));
    const extraHasFuel = extras.some((row) => String(row?.type || '').toLowerCase().includes('fuel'));
    const rows = [
        { label: 'Basic salary', amount: money(entry?.basic) },
        { label: 'House rent allowance', amount: money(entry?.houseRentAllowance) },
        { label: 'Other allowance', amount: money(entry?.otherAllowance) },
        extraHasVehicle ? null : { label: 'Vehicle allowance', amount: money(entry?.vehicleAllowance) },
        extraHasFuel ? null : { label: 'Fuel allowance', amount: money(entry?.fuelAllowance) },
        ...extras.map((row) => ({
            label: String(row?.type || 'Allowance').trim() || 'Allowance',
            amount: money(row?.amount),
        })),
    ].filter(Boolean);
    const total =
        money(entry?.totalSalary) ||
        money(entry?.monthlySalary) ||
        rows.reduce((sum, row) => sum + money(row.amount), 0);
    if (total > 0 && !rows.some((row) => row.amount > 0)) {
        rows.push({ label: 'Monthly salary', amount: total, always: true });
    }
    return { rows, total };
}

function mailTransport() {
    const emailUser =
        process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
    const emailPass =
        process.env.EMAIL_PASS || process.env.VERP_PASS || process.env.GMAIL_PASS;
    if (!emailUser || !emailPass) return null;
    const smtpHost =
        emailUser.includes('@gmail.com') || process.env.GMAIL_USER
            ? 'smtp.gmail.com'
            : 'smtp.office365.com';
    return {
        transporter: nodemailer.createTransport({
            host: smtpHost,
            port: 587,
            secure: false,
            auth: { user: emailUser, pass: emailPass },
        }),
        from: emailUser,
    };
}

function emailHtml({ name, month, attachedSlip }) {
    const slipLine = attachedSlip
        ? '<p>Your salary slip for this month is attached.</p>'
        : '';
    return `
        <div style="font-family:Segoe UI,Tahoma,sans-serif;color:#1e293b;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
            <div style="background:#0F766E;color:#fff;padding:20px;text-align:center;">
                <h1 style="margin:0;font-size:20px;">Salary approved</h1>
            </div>
            <div style="padding:24px;font-size:14px;line-height:1.55;">
                <p>Hello ${name},</p>
                <p>Payroll for <strong>${month}</strong> has been approved by Management.</p>
                ${slipLine}
                <p style="margin-top:24px;color:#64748b;font-size:12px;">This is an automated message from VERP Payroll.</p>
            </div>
        </div>
    `;
}

async function buildSlipPdf({ emp, salaryDoc, monthKey, month }) {
    const entry = historyEntryForMonth(salaryDoc, monthKey);
    const { rows, total } = salaryEarnings(entry);
    const html = buildSalarySlipPdfHtml({
        monthLabel: month,
        employeeName: personName(emp),
        employeeId: emp.employeeId,
        designation: String(emp.designation || '').trim(),
        companyName: companyNameOf(emp),
        earnings: rows,
        netSalary: total,
    });
    const raw = await generatePdfFromHtml(html, SALARY_SLIP_PDF_SELECTOR);
    const buf = pdfOutputToBuffer(raw);
    return buf && buf.length > 500 ? buf : null;
}

export async function notifySalaryMonthApprovedEmployees({ monthKey } = {}) {
    const ym = monthKeyOf(monthKey);
    if (!ym) return { sent: 0 };

    const mail = mailTransport();
    if (!mail) {
        console.warn('[notifySalaryMonthApprovedEmployees] Email is not configured.');
        return { sent: 0 };
    }

    const [storedEnrollments, historicalRows] = await Promise.all([
        SalaryEnrollment.find({})
            .select('employeeId fromMonth monthKey createdAt')
            .lean()
            .maxTimeMS(8000),
        SalaryHistoricalProfile.find({})
            .select('employeeId verpStartDate salarySlip workflowStatus')
            .lean()
            .maxTimeMS(8000),
    ]);

    const enrolledCodes = new Set();
    for (const row of storedEnrollments || []) {
        const from =
            toYearMonth(row.fromMonth) ||
            toYearMonth(row.monthKey) ||
            toYearMonth(row.createdAt);
        const code = String(row.employeeId || '').trim();
        if (code && from && from <= ym) enrolledCodes.add(code);
    }
    for (const row of historicalRows || []) {
        if (String(row.workflowStatus || '') !== 'locked') continue;
        const from = toYearMonth(row.verpStartDate) || toYearMonth(row.fromMonth);
        const code = String(row.employeeId || '').trim();
        if (code && from && from <= ym) enrolledCodes.add(code);
    }

    const codes = [...enrolledCodes].filter(Boolean);
    if (!codes.length) return { sent: 0 };

    const slipByCode = new Map(
        (historicalRows || [])
            .filter((row) => enrolledCodes.has(String(row.employeeId || '').trim()))
            .map((row) => [String(row.employeeId || '').trim(), Boolean(row.salarySlip)]),
    );

    const [employees, salaryDocs] = await Promise.all([
        EmployeeBasic.find({
            employeeId: { $in: codes },
            status: { $ne: 'Left User' },
            ...REAL_EMPLOYEE_MONGO_FILTER,
        })
            .select('employeeId firstName lastName designation status companyEmail company')
            .populate('company', 'name nickName')
            .lean()
            .maxTimeMS(12000),
        EmployeeSalary.find({ employeeId: { $in: codes } })
            .select('-offerLetter.data -salaryHistory.attachment.data -salaryHistory.offerLetter.data')
            .lean()
            .maxTimeMS(12000),
    ]);

    const salaryByCode = new Map(
        (salaryDocs || []).map((doc) => [String(doc.employeeId || '').trim(), doc]),
    );
    const month = monthLabel(ym);
    let sent = 0;

    for (const emp of employees || []) {
        if (isCompanyShellEmployee(emp) || isPlaceholderEmployeeId(emp.employeeId)) continue;
        const to = String(emp.companyEmail || '').trim();
        if (!to) continue;

        const code = String(emp.employeeId || '').trim();
        const attachSlip = Boolean(slipByCode.get(code));
        const attachments = [];
        if (attachSlip) {
            try {
                const pdf = await buildSlipPdf({
                    emp,
                    salaryDoc: salaryByCode.get(code),
                    monthKey: ym,
                    month,
                });
                if (pdf) {
                    attachments.push({
                        filename: `Salary-Slip-${ym}-${code}.pdf`,
                        content: pdf,
                        contentType: 'application/pdf',
                    });
                }
            } catch (err) {
                console.error(
                    `[notifySalaryMonthApprovedEmployees] slip failed for ${code}:`,
                    err?.message || err,
                );
            }
        }

        try {
            const result = await sendErpEmail({
                transporter: mail.transporter,
                from: `"VERP Payroll" <${mail.from}>`,
                to,
                subject: `Salary approved — ${month}`,
                html: emailHtml({
                    name: personName(emp),
                    month,
                    attachedSlip: attachments.length > 0,
                }),
                attachments,
                dedupeKey: buildEmailDedupeKey(['SalaryMonthApproved', ym, code]),
                module: 'Salary',
                emailType: 'month_approved',
                recordId: ym,
                metadata: { subjectCategory: 'completed' },
            });
            if (result?.sent) sent += 1;
        } catch (err) {
            console.error(
                `[notifySalaryMonthApprovedEmployees] email failed for ${code}:`,
                err?.message || err,
            );
        }
    }

    return { sent };
}
