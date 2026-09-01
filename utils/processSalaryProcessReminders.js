import EmployeeBasic from '../models/EmployeeBasic.js';
import PayrollSettings from '../models/PayrollSettings.js';
import SalaryEnrollment from '../models/SalaryEnrollment.js';
import SalaryProcessReminderLog from '../models/SalaryProcessReminderLog.js';
import { isEmployeeActiveForNotifications } from './applyEmployeeLeftUserStatus.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { getManagementHOD } from './getManagementHOD.js';
import { withFrontendPath } from './resolveFrontendBaseUrl.js';
import { sendMailLater } from './salaryEnrollmentApprovalNotify.js';
import {
    getCalendarPartsInTz,
    getScheduledEmailTimeZone,
    zonedWallTimeToUtc,
} from './scheduleDailyAtMidnight.js';

const STAGE_LABELS = ['1st reminder', '2nd reminder', '3rd reminder', 'Salary processing'];
const REMINDER_AUDIENCE_KEYS = new Set([
    'wfAccounts',
    'wfHr',
    'wfAdmin',
    'wfManagement',
    'pendingTaskUser',
]);
const LEGACY_REMINDER_AUDIENCE = {
    accounts: 'wfAccounts',
    hr: 'wfHr',
    pendingEmployee: 'pendingTaskUser',
    primaryReportee: 'pendingTaskUser',
};

export function reminderAudiences(value) {
    const items = Array.isArray(value) ? value : value ? [value] : [];
    return [
        ...new Set(
            items
                .map((item) => {
                    const raw = String(item || '').trim();
                    if (REMINDER_AUDIENCE_KEYS.has(raw)) return raw;
                    return LEGACY_REMINDER_AUDIENCE[raw] || '';
                })
                .filter(Boolean),
        ),
    ];
}

function reminderTz() {
    return getScheduledEmailTimeZone();
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function displayName(emp) {
    return `${emp?.firstName || ''} ${emp?.lastName || ''}`.trim() || String(emp?.employeeId || '').trim() || 'there';
}

export function processingDayFromPolicy(value) {
    const n = Number(String(value || '').trim());
    if (!Number.isInteger(n) || n < 1) return 1;
    return Math.min(28, n);
}

export function yearMonthKeyFromParts(year, month) {
    return `${year}-${String(month).padStart(2, '0')}`;
}

export function monthKeyIsOnOrAfterStart(monthKey, startMonth) {
    const start = String(startMonth || '').trim();
    if (!/^\d{4}-\d{2}$/.test(start)) return true;
    return String(monthKey || '') >= start;
}

export function processingDateForMonth(year, month, processingDay, timeZone = reminderTz()) {
    const day = processingDayFromPolicy(processingDay);
    return zonedWallTimeToUtc({ year, month, day, hour: 0, minute: 0, second: 0 }, timeZone);
}

export function nextSalaryProcessingTarget(now = new Date(), processingDay = 1, timeZone = reminderTz()) {
    const { year, month, day } = getCalendarPartsInTz(now, timeZone);
    const today = zonedWallTimeToUtc({ year, month, day, hour: 0, minute: 0, second: 0 }, timeZone);
    let y = year;
    let m = month;
    let due = processingDateForMonth(y, m, processingDay, timeZone);
    if (due.getTime() < today.getTime()) {
        if (m === 12) {
            y += 1;
            m = 1;
        } else {
            m += 1;
        }
        due = processingDateForMonth(y, m, processingDay, timeZone);
    }
    return {
        daysUntil: Math.round((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)),
        dueDate: due,
        monthKey: yearMonthKeyFromParts(y, m),
        year: y,
        month: m,
    };
}

export function matchingReminderStages(reminders, daysUntil) {
    const rows = Array.isArray(reminders) ? reminders : [];
    const seen = new Set();
    const matches = [];
    rows.forEach((row, index) => {
        if (row?.daysBefore == null || row?.daysBefore === '') return;
        const days = Number(row.daysBefore);
        if (!Number.isInteger(days) || days !== daysUntil) return;
        const forWhom = reminderAudiences(row?.forWhom);
        if (!forWhom.length) return;
        if (seen.has(days)) return;
        seen.add(days);
        matches.push({
            daysBefore: days,
            forWhom,
            index,
            stageLabel: STAGE_LABELS[index] || (days === 0 ? 'Salary processing' : 'Reminder'),
        });
    });
    return matches;
}

export function salaryProcessCompanyEmail(emp) {
    const company = String(emp?.companyEmail || emp?.workEmail || '').trim().toLowerCase();
    if (company) return company;
    if (emp?.isFlowchartOnly) return String(emp?.email || '').trim().toLowerCase();
    return '';
}

function formatMonthLabel(monthKey, timeZone = reminderTz()) {
    const ym = String(monthKey || '');
    if (!/^\d{4}-\d{2}$/.test(ym)) return ym;
    const [yearStr, monthStr] = ym.split('-');
    const probe = zonedWallTimeToUtc(
        { year: Number(yearStr), month: Number(monthStr), day: 1, hour: 12 },
        timeZone,
    );
    return probe.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone });
}

function formatDueDateLabel(dueDate, timeZone = reminderTz()) {
    if (!dueDate) return '';
    return dueDate.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone,
    });
}

function reminderEmailHtml({ name, stageLabel, daysBefore, monthLabel, dueDateLabel, href, forEmployee }) {
    const processLine =
        daysBefore === 0
            ? `Salary for <strong>${escapeHtml(monthLabel)}</strong> is processed today (${escapeHtml(dueDateLabel)}).`
            : `Salary for <strong>${escapeHtml(monthLabel)}</strong> will be processed on <strong>${escapeHtml(dueDateLabel)}</strong>.`;
    const whoLine = forEmployee
        ? 'Your salary for this month is included.'
        : 'This reminder was sent because you are designated on the salary process flowchart.';
    return `
        <p>Hello ${escapeHtml(name)},</p>
        <p>This is the <strong>${escapeHtml(stageLabel)}</strong>.</p>
        <p>${processLine}</p>
        <p>${whoLine}</p>
        <p><a href="${escapeHtml(href)}">Open Salary</a></p>
    `;
}

async function wasSent(yearMonth, daysBefore, email) {
    const hit = await SalaryProcessReminderLog.findOne({
        yearMonth,
        daysBefore,
        email,
    })
        .select('_id')
        .lean();
    return Boolean(hit);
}

async function markSent({ yearMonth, daysBefore, email, employeeId, dueDate }) {
    try {
        await SalaryProcessReminderLog.create({
            yearMonth,
            daysBefore,
            email,
            employeeId: String(employeeId || '').trim(),
            dueDate,
        });
    } catch (err) {
        if (err?.code !== 11000) throw err;
    }
}

async function flowchartRecipients(audiences) {
    const people = [];
    const seen = new Set();
    async function push(empPromise, role) {
        const emp = await empPromise;
        const email = salaryProcessCompanyEmail(emp);
        const employeeId = String(emp?.employeeId || '').trim();
        if (!emp || !email || seen.has(email)) return;
        seen.add(email);
        people.push({
            email,
            employeeId,
            name: displayName(emp),
            role,
            forEmployee: false,
        });
    }
    if (audiences.has('wfAccounts')) await push(getDepartmentHOD('accounts'), 'WF Accounts');
    if (audiences.has('wfHr')) await push(getDepartmentHOD('hr'), 'WF HR');
    if (audiences.has('wfAdmin')) await push(getDepartmentHOD('admincontroller'), 'WF Admin');
    if (audiences.has('wfManagement')) await push(getManagementHOD(), 'WF Management');
    return people;
}

async function enrolledSalaryRecipients(monthKey, seenEmails) {
    const enrollments = await SalaryEnrollment.find({ fromMonth: { $lte: monthKey } })
        .select('employeeId fromMonth')
        .lean();
    const employeeIds = [
        ...new Set(enrollments.map((row) => String(row.employeeId || '').trim()).filter(Boolean)),
    ];
    if (!employeeIds.length) return [];

    const employees = await EmployeeBasic.find({
        employeeId: { $in: employeeIds },
        status: { $ne: 'Left User' },
    })
                    .select('employeeId firstName lastName companyEmail status profileStatus')
        .lean();

    const people = [];
    for (const emp of employees) {
        if (!isEmployeeActiveForNotifications(emp)) continue;
        const email = salaryProcessCompanyEmail(emp);
        if (!email || seenEmails.has(email)) continue;
        seenEmails.add(email);
        people.push({
            email,
            employeeId: String(emp.employeeId || '').trim(),
            name: displayName(emp),
            role: 'Pending task user',
            forEmployee: true,
        });
    }
    return people;
}

async function resolveStageRecipients(forWhom, monthKey) {
    const audiences = new Set(forWhom);
    const flowchart = await flowchartRecipients(audiences);
    const seen = new Set(flowchart.map((row) => row.email));
    const enrolled = audiences.has('pendingTaskUser')
        ? await enrolledSalaryRecipients(monthKey, seen)
        : [];
    return [...flowchart, ...enrolled];
}

/**
 * Daily: if salary policy reminders are set, email checked audiences
 * (flowchart company emails + enrolled employees with company email)
 * N days before the processing date, then again on the processing date.
 */
export async function processSalaryProcessReminders(now = new Date()) {
    try {
        const policy = await PayrollSettings.findOne({ key: 'default' }).lean();
        if (!policy?._id) return { skipped: 'no-policy', sent: 0 };

        const processingDay = processingDayFromPolicy(policy.salaryProcessingDate);
        const tz = reminderTz();
        const target = nextSalaryProcessingTarget(now, processingDay, tz);
        if (!monthKeyIsOnOrAfterStart(target.monthKey, policy.salaryProcessStartMonth)) {
            return { skipped: 'before-start-month', monthKey: target.monthKey, sent: 0 };
        }

        const stages = matchingReminderStages(policy.salaryProcessReminders, target.daysUntil);
        if (!stages.length) {
            return { skipped: 'no-matching-stage', daysUntil: target.daysUntil, sent: 0 };
        }

        const monthLabel = formatMonthLabel(target.monthKey, tz);
        const dueDateLabel = formatDueDateLabel(target.dueDate, tz);
        const href = withFrontendPath('/HRM/Salary');
        let sent = 0;
        let skipped = 0;

        for (const stage of stages) {
            const recipients = await resolveStageRecipients(stage.forWhom, target.monthKey);
            for (const person of recipients) {
                try {
                    if (await wasSent(target.monthKey, stage.daysBefore, person.email)) {
                        skipped += 1;
                        continue;
                    }
                    sendMailLater({
                        to: person.email,
                        subject:
                            stage.daysBefore === 0
                                ? `Salary processing — ${monthLabel}`
                                : `Salary process ${stage.stageLabel} — ${monthLabel}`,
                        html: reminderEmailHtml({
                            name: person.name,
                            stageLabel: stage.stageLabel,
                            daysBefore: stage.daysBefore,
                            monthLabel,
                            dueDateLabel,
                            href,
                            forEmployee: person.forEmployee,
                        }),
                    });
                    await markSent({
                        yearMonth: target.monthKey,
                        daysBefore: stage.daysBefore,
                        email: person.email,
                        employeeId: person.employeeId,
                        dueDate: target.dueDate,
                    });
                    sent += 1;
                } catch (personErr) {
                    console.error(
                        `[SalaryProcessReminders] ${person.email} ${target.monthKey} T-${stage.daysBefore}:`,
                        personErr?.message || personErr,
                    );
                }
            }
        }

        if (sent > 0) {
            console.log(
                `[SalaryProcessReminders] sent ${sent} for ${target.monthKey} (${STAGE_LABELS.find((_, i) => stages[0]?.index === i) || `T-${target.daysUntil}`})`,
            );
        }
        return { sent, skipped, monthKey: target.monthKey, daysUntil: target.daysUntil };
    } catch (err) {
        console.error('[processSalaryProcessReminders] Non-fatal error:', err?.message || err);
        return { sent: 0, error: err?.message || String(err) };
    }
}
