import Attendance from '../models/Attendance.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import EmployeeSalary from '../models/EmployeeSalary.js';
import Fine from '../models/Fine.js';
import Holiday from '../models/Holiday.js';
import Loan from '../models/Loan.js';
import PayrollSettings from '../models/PayrollSettings.js';
import Reward from '../models/Reward.js';
import SalaryHistoricalProfile from '../models/SalaryHistoricalProfile.js';
import UtilityBillPayment from '../models/UtilityBillPayment.js';
import { isCompanyShellEmployee } from './attendanceEmployeeFilters.js';
import { resolveEmployeeFinePayableAmount } from './finePayableAmount.js';
import { getScheduledEmailTimeZone, getZonedParts } from './scheduleDailyAtMidnight.js';
import { buildLoanInstallments } from './upsertLoanPartyExpenseFromPayment.js';
import {
    clockTimeToMinutes,
    getScheduledPunchMinutes,
    getWeekForStaffType,
    holidayAppliesToStaff,
    loadWorkingTimeDoc,
} from './workingTimeHelpers.js';
import { getVegaLogoDataUrl } from './buildSalarySlipPdfHtml.js';

const MONTH_FULL = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];
const APPROVED_LOAN_STATUSES = ['Approved', 'Pending Payment to Employee', 'Paid'];
const APPROVED_FINE_STATUSES = ['Approved', 'Active', 'Paid', 'Completed'];
const APPROVED_REWARD_STATUSES = ['Approved', 'Approved (Paid)'];
const PRESENT_KEYS = new Set(['on_office', 'work_from_home', 'late_arrived', 'early_go']);
const LEAVE_KEYS = new Set(['authorized_leave', 'unauthorized_leave', 'sick_leave', 'on_leave']);
const OT_MULTIPLIER = 1.25;
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
const TEENS = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

export class SalarySlipError extends Error {
    constructor(message, statusCode = 400) {
        super(message);
        this.statusCode = statusCode;
    }
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

function money(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function formatAed(value) {
    return `AED ${money(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function monthKeyOf(value) {
    const raw = String(value || '').trim();
    if (/^\d{4}-\d{2}$/.test(raw)) return raw;
    const iso = raw.match(/^(\d{4}-\d{2})/);
    if (iso) return iso[1];
    const named = raw.match(/^([A-Za-z]+)\s+(\d{4})$/);
    if (named) {
        const idx = MONTH_FULL.findIndex((name) => name.toLowerCase() === named[1].toLowerCase());
        if (idx >= 0) return `${named[2]}-${pad2(idx + 1)}`;
    }
    return '';
}

export function defaultSalarySlipMonthKey(now = new Date()) {
    const dubai = getZonedParts(now, getScheduledEmailTimeZone());
    let year = dubai.year;
    let month = dubai.month - 1;
    if (month < 1) {
        month = 12;
        year -= 1;
    }
    return `${year}-${pad2(month)}`;
}

function monthLabelOf(ym) {
    const match = String(ym || '').match(/^(\d{4})-(\d{2})$/);
    if (!match) return ym || '';
    const name = MONTH_FULL[Number(match[2]) - 1];
    return name ? `${name} ${match[1]}` : ym;
}

function lastDayOfMonth(ym) {
    const match = String(ym || '').match(/^(\d{4})-(\d{2})$/);
    if (!match) return 30;
    return new Date(Number(match[1]), Number(match[2]), 0).getDate();
}

function paymentDateLabel(ym) {
    const match = String(ym || '').match(/^(\d{4})-(\d{2})$/);
    if (!match) return '—';
    const day = lastDayOfMonth(ym);
    const name = MONTH_FULL[Number(match[2]) - 1];
    return `${day} ${name} ${match[1]}`;
}

function groupWords(n) {
    const hundred = Math.floor(n / 100);
    const rest = n % 100;
    const parts = [];
    if (hundred) parts.push(`${ONES[hundred]} Hundred`);
    if (rest >= 10 && rest < 20) {
        parts.push(TEENS[rest - 10]);
    } else {
        if (rest >= 20) {
            const ten = TENS[Math.floor(rest / 10)];
            const one = ONES[rest % 10];
            parts.push(one ? `${ten}-${one}` : ten);
        } else if (rest > 0) {
            parts.push(ONES[rest]);
        }
    }
    return parts.join(' ');
}

export function amountInWordsAed(value) {
    const amount = Math.max(0, money(value));
    const dirhams = Math.floor(amount);
    const fils = Math.round((amount - dirhams) * 100);
    if (dirhams === 0 && fils === 0) return 'Zero Dirhams Only';
    const billion = Math.floor(dirhams / 1_000_000_000);
    const million = Math.floor((dirhams % 1_000_000_000) / 1_000_000);
    const thousand = Math.floor((dirhams % 1_000_000) / 1000);
    const rest = dirhams % 1000;
    const chunks = [];
    if (billion) chunks.push(`${groupWords(billion)} Billion`);
    if (million) chunks.push(`${groupWords(million)} Million`);
    if (thousand) chunks.push(`${groupWords(thousand)} Thousand`);
    if (rest) chunks.push(groupWords(rest));
    const dirhamPart = dirhams === 0 ? 'Zero Dirhams' : `${chunks.join(' ')} Dirham${dirhams === 1 ? '' : 's'}`;
    if (!fils) return `${dirhamPart} Only`;
    const filsWords = fils < 20 && fils >= 10
        ? TEENS[fils - 10]
        : fils < 10
            ? ONES[fils]
            : `${TENS[Math.floor(fils / 10)]}${fils % 10 ? `-${ONES[fils % 10]}` : ''}`;
    return `${dirhamPart} and ${filsWords} Fils Only`;
}

function qtyLabel(count, unit) {
    const n = Number(count) || 0;
    const shown = Number.isInteger(n) ? String(n) : String(n);
    const plural = n === 0 || Math.abs(n) >= 2;
    return `${shown} ${unit}${plural ? 's' : ''}`;
}

function hoursLabel(hours) {
    const n = money(hours);
    const shown = Number.isInteger(n) ? String(n) : n.toFixed(1);
    return `${shown} hour${n === 1 ? '' : 's'}`;
}

function personName(row) {
    return `${row?.firstName || ''} ${row?.lastName || ''}`.trim() || row?.employeeId || 'Employee';
}

function companyNameOf(emp) {
    const company = emp?.company;
    if (!company) return 'VEGA DIGITAL IT SOLUTIONS LLC';
    if (typeof company === 'string') return company.trim() || 'VEGA DIGITAL IT SOLUTIONS LLC';
    return String(company.name || company.nickName || '').trim() || 'VEGA DIGITAL IT SOLUTIONS LLC';
}

function slipRefOf(ym, employeeId) {
    const nums = String(employeeId || '').match(/(\d+)\s*$/);
    const seq = (nums ? nums[1] : '1').padStart(3, '0');
    const [year, month] = String(ym).split('-');
    return `PSL-${year}-${month}-${seq}`;
}

function toYearMonth(value) {
    if (!value) return '';
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}`;
    }
    return monthKeyOf(value);
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

function monthlySalaryOf(entry) {
    if (!entry) return 0;
    const extras = Array.isArray(entry.additionalAllowances) ? entry.additionalAllowances : [];
    const extraSum = extras.reduce((sum, row) => sum + money(row?.amount), 0);
    const extraHasVehicle = extras.some((row) => String(row?.type || '').toLowerCase().includes('vehicle'));
    const extraHasFuel = extras.some((row) => String(row?.type || '').toLowerCase().includes('fuel'));
    const stored = money(entry.totalSalary) || money(entry.monthlySalary);
    const computed =
        money(entry.basic) +
        money(entry.houseRentAllowance) +
        money(entry.otherAllowance) +
        (extraHasVehicle ? 0 : money(entry.vehicleAllowance)) +
        (extraHasFuel ? 0 : money(entry.fuelAllowance)) +
        extraSum;
    return stored > 0 ? stored : computed;
}

function structureEarnings(entry) {
    const extras = Array.isArray(entry?.additionalAllowances) ? entry.additionalAllowances : [];
    const extraHasVehicle = extras.some((row) => String(row?.type || '').toLowerCase().includes('vehicle'));
    const extraHasFuel = extras.some((row) => String(row?.type || '').toLowerCase().includes('fuel'));
    const rows = [
        { component: 'Basic Salary', basis: 'Monthly', amount: money(entry?.basic) },
        { component: 'Other Allowance', basis: 'Monthly', amount: money(entry?.otherAllowance) },
        { component: 'Accommodation Allowance', basis: 'Monthly', amount: money(entry?.houseRentAllowance) },
        extraHasVehicle ? null : { component: 'Vehicle Allowance', basis: 'Monthly', amount: money(entry?.vehicleAllowance) },
        extraHasFuel ? null : { component: 'Fuel Allowance', basis: 'Monthly', amount: money(entry?.fuelAllowance) },
        ...extras.map((row) => ({
            component: String(row?.type || 'Allowance').trim() || 'Allowance',
            basis: 'Monthly',
            amount: money(row?.amount),
        })),
    ].filter(Boolean);
    const always = new Set(['Basic Salary', 'Other Allowance', 'Accommodation Allowance']);
    return rows.filter((row) => always.has(row.component) || row.amount > 0);
}

function overtimeFromPunch({ timeIn, timeOut, date, week, monthlySalary }) {
    const actualIn = clockTimeToMinutes(timeIn);
    const actualOut = clockTimeToMinutes(timeOut);
    if (actualIn == null || actualOut == null || monthlySalary <= 0) {
        return { amount: 0, hours: 0, isOffDay: false };
    }
    let worked = actualOut - actualIn;
    if (worked <= 0) worked += 24 * 60;
    const scheduled = getScheduledPunchMinutes(week, date);
    let scheduledMinutes = 0;
    if (!scheduled.isOffDay) {
        scheduledMinutes = (scheduled.endMinutes ?? 18 * 60) - (scheduled.startMinutes ?? 9 * 60);
        if (scheduledMinutes <= 0) scheduledMinutes += 24 * 60;
    }
    const otMinutes = scheduled.isOffDay ? worked : Math.max(0, worked - scheduledMinutes);
    if (otMinutes <= 0) return { amount: 0, hours: 0, isOffDay: Boolean(scheduled.isOffDay) };
    const dayHours = (scheduledMinutes > 0 ? scheduledMinutes : 8 * 60) / 60;
    const hourly = monthlySalary / 30 / dayHours;
    return {
        amount: money(hourly * OT_MULTIPLIER * (otMinutes / 60)),
        hours: otMinutes / 60,
        isOffDay: Boolean(scheduled.isOffDay),
    };
}

function lateRateFromPolicy(dailyRate, lateInRules) {
    const rule = Array.isArray(lateInRules) ? lateInRules[0] : null;
    const deduct = String(rule?.deduct || '').trim().toLowerCase();
    const fraction = deduct === 'full' ? 1 : deduct === 'half' ? 0.5 : deduct === 'quarter' ? 0.25 : 0;
    return money(dailyRate * fraction);
}

function cycleInMonth(dateValue, ym) {
    return monthKeyOf(dateValue) === ym || toYearMonth(dateValue) === ym;
}

function addMonthsYm(ym, count) {
    const match = String(ym || '').match(/^(\d{4})-(\d{2})$/);
    if (!match) return '';
    const date = new Date(Number(match[1]), Number(match[2]) - 1 + count, 1);
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

function scheduleHasMonth(startYm, duration, ym) {
    const months = Math.max(1, Number(duration) || 1);
    if (!startYm) return false;
    for (let i = 0; i < months; i += 1) {
        if (addMonthsYm(startYm, i) === ym) return true;
    }
    return false;
}

function emptyLoanRow(type) {
    return {
        type,
        original: formatAed(0),
        thisMonth: formatAed(0),
        paidToDate: formatAed(0),
        remaining: formatAed(0),
        schedule: '—',
        thisMonthAmount: 0,
    };
}

/**
 * Build the VEGA salary-slip view model for one employee and YYYY-MM.
 */
export async function buildSalarySlipPayload({ employeeId, monthKey, emp: preloadedEmp, salaryDoc: preloadedSalary } = {}) {
    const code = String(employeeId || preloadedEmp?.employeeId || '').trim();
    const ym = monthKeyOf(monthKey) || defaultSalarySlipMonthKey();
    if (!code) throw new SalarySlipError('Employee is required.', 400);
    if (!ym) throw new SalarySlipError('Salary month is required.', 400);

    const emp =
        preloadedEmp ||
        (await EmployeeBasic.findOne({ employeeId: code })
            .select('employeeId firstName lastName designation staffType status overtime company dateOfJoining noticeRequest.exitDate')
            .populate('company', 'name nickName')
            .lean());
    if (!emp || isCompanyShellEmployee(emp)) {
        throw new SalarySlipError('Employee not found.', 404);
    }

    const mongoId = String(emp._id);
    const daysInMonth = lastDayOfMonth(ym);
    const from = `${ym}-01`;
    const to = `${ym}-${pad2(daysInMonth)}`;

    const [salaryDoc, profile, policy, workingTime, attendance, holidayDocs, loans, fines, rewards, utilityBills] =
        await Promise.all([
            preloadedSalary ||
                EmployeeSalary.findOne({ employeeId: code })
                    .select('-offerLetter.data -salaryHistory.attachment.data -salaryHistory.offerLetter.data')
                    .lean(),
            SalaryHistoricalProfile.findOne({ employeeId: code })
                .select('salarySlip companyMolCode paymentCycles')
                .lean(),
            PayrollSettings.findOne({ key: 'default' }).select('lateInRules').lean(),
            loadWorkingTimeDoc(),
            Attendance.find({
                $or: [{ employeeMongoId: mongoId }, { employeeId: code }],
                date: { $gte: from, $lte: to },
            })
                .select('date statusKey leavePayType timeIn timeOut')
                .lean(),
            Holiday.find({ date: { $gte: from, $lte: to } }).select('date appliesTo').lean(),
            Loan.find({
                $and: [
                    { $or: [{ employeeId: code }, { employeeObjectId: emp._id }] },
                    {
                        $or: [
                            { approvalStatus: { $in: APPROVED_LOAN_STATUSES } },
                            { status: { $in: APPROVED_LOAN_STATUSES } },
                        ],
                    },
                ],
            })
                .select('employeeId type amount paidAmount repaidAmount duration monthStart originalMonthStart originalDuration approvalStatus status approvedDate appliedDate')
                .lean(),
            Fine.find({
                fineStatus: { $in: APPROVED_FINE_STATUSES },
                sourceOfIncome: { $ne: 'End of Service' },
                'assignedEmployees.employeeId': code,
            })
                .select('fineType subCategory category assignedEmployees employeeAmount companyAmount serviceCharge discount totalFineAmount fineAmount fineStatus sourceOfIncome payableDuration monthStart originalMonthStart originalPayableDuration responsibleFor awardedDate createdAt paidAmount')
                .lean(),
            Reward.find({
                employeeId: code,
                $or: [
                    { rewardStatus: { $in: APPROVED_REWARD_STATUSES } },
                    { approvalStatus: { $in: APPROVED_REWARD_STATUSES } },
                ],
            })
                .select('amount awardedDate approvedDate rewardStatus rewardType')
                .lean(),
            UtilityBillPayment.find({
                payByEmployeeId: code,
                status: { $in: ['Approved', 'Paid'] },
            })
                .select('utilityType billMonth employeePayAmount employeeDiffAmount notes status')
                .lean(),
        ]);

    const entry = historyEntryForMonth(salaryDoc, ym);
    const monthly = monthlySalaryOf(entry);
    const daily = monthly > 0 ? money(monthly / 30) : 0;
    const week = getWeekForStaffType(workingTime, emp.staffType);
    const holidaySet = new Set(
        (holidayDocs || [])
            .filter((row) => holidayAppliesToStaff(row, emp.staffType))
            .map((row) => String(row.date || '').trim()),
    );

    let presentDays = 0;
    let workingDayLeaves = 0;
    let unauthorizedDays = 0;
    let annualDays = 0;
    let lateEvents = 0;
    let holidayMarks = 0;
    let holidaysWorked = 0;
    let compOffDays = 0;
    let otHours = 0;
    let otHoursAmount = 0;
    let otDays = 0;
    let otDaysAmount = 0;

    for (const row of attendance || []) {
        const key = String(row.statusKey || '');
        const date = String(row.date || '');
        if (key === 'holiday') holidayMarks += 1;
        if (key === 'compoff_leave') compOffDays += 1;
        if (key === 'late_arrived') lateEvents += 1;
        if (PRESENT_KEYS.has(key)) presentDays += 1;
        if (LEAVE_KEYS.has(key)) workingDayLeaves += 1;
        if (key === 'unauthorized_leave') unauthorizedDays += 1;
        if (key === 'on_leave') annualDays += 1;

        const isHolidayDate = holidaySet.has(date) || key === 'holiday';
        const punched = Boolean(row.timeIn && row.timeOut);
        if (isHolidayDate && punched) holidaysWorked += 1;

        const ot = overtimeFromPunch({
            timeIn: row.timeIn,
            timeOut: row.timeOut,
            date,
            week,
            monthlySalary: monthly,
        });
        if (ot.hours <= 0) continue;
        if (ot.isOffDay || isHolidayDate) {
            otDays += 1;
            otDaysAmount = money(otDaysAmount + ot.amount);
        } else {
            otHours += ot.hours;
            otHoursAmount = money(otHoursAmount + ot.amount);
        }
    }

    const holidays = Math.max(holidaySet.size, holidayMarks);
    const unpaidAuthorized = (attendance || []).filter(
        (row) =>
            String(row.statusKey || '') === 'authorized_leave' &&
            String(row.leavePayType || '').toLowerCase() === 'unpaid',
    ).length;
    const authorizedDeductionDays = unpaidAuthorized;
    const authorizedAmount = money(daily * authorizedDeductionDays);
    const unauthorizedAmount = money(daily * unauthorizedDays);
    const annualAmount = 0;
    const lateRate = lateRateFromPolicy(daily, policy?.lateInRules);
    const lateAmount = money(lateRate * lateEvents);

    const earnings = structureEarnings(entry);
    if (otHoursAmount > 0) {
        earnings.push({
            component: 'Overtime Hours',
            basis: hoursLabel(otHours).replace(/ hours?$/, ' h'),
            amount: otHoursAmount,
        });
    }
    if (otDaysAmount > 0) {
        earnings.push({
            component: 'Overtime Days',
            basis: qtyLabel(otDays, 'day'),
            amount: otDaysAmount,
        });
    }

    let leaveSalaryAmount = 0;
    let leaveSalaryDays = 0;
    let ticketAmount = 0;
    for (const cycle of profile?.paymentCycles || []) {
        const status = String(cycle.paymentStatus || cycle.status || '').toLowerCase();
        if (status === 'draft' || status === 'cancelled' || status === 'rejected') continue;
        if (cycleInMonth(cycle.leaveSalaryPaymentDate || cycle.paymentDate, ym)) {
            const cycleLeave = money(cycle.leaveSalaryAmount || cycle.leaveSalary);
            leaveSalaryAmount = money(leaveSalaryAmount + cycleLeave);
            if (daily > 0 && cycleLeave > 0) {
                leaveSalaryDays += Math.round(cycleLeave / daily);
            }
        }
        if (cycleInMonth(cycle.ticketPaymentDate || cycle.paymentDate, ym)) {
            ticketAmount = money(ticketAmount + money(cycle.ticketAmount));
        }
    }
    if (leaveSalaryAmount > 0) {
        earnings.push({
            component: 'Leave Salary',
            basis: leaveSalaryDays > 0 ? qtyLabel(leaveSalaryDays, 'day') : 'Annual',
            amount: leaveSalaryAmount,
        });
    }
    if (ticketAmount > 0) {
        earnings.push({ component: 'Ticket', basis: 'Annual', amount: ticketAmount });
    }

    let rewardAmount = 0;
    for (const reward of rewards || []) {
        const when = toYearMonth(reward.awardedDate || reward.approvedDate);
        if (when !== ym) continue;
        if (String(reward.rewardType || '') === 'Certificate') continue;
        rewardAmount = money(rewardAmount + money(reward.amount));
    }
    if (rewardAmount > 0) {
        earnings.push({ component: 'Reward', basis: 'Approved', amount: rewardAmount });
    }

    let advanceMonth = 0;
    let loanMonth = 0;
    const loanSchedule = [];
    for (const loan of loans || []) {
        const duration = loan.originalDuration ?? loan.duration;
        const start = loan.originalMonthStart || loan.monthStart || toYearMonth(loan.approvedDate || loan.appliedDate);
        const installments = buildLoanInstallments({
            ...loan,
            monthStart: start,
            duration,
        });
        const part = installments.find((row) => row.monthKey === ym);
        const thisMonthAmount = money(part?.amount);
        const total = money(loan.amount);
        const repaid = money(loan.repaidAmount ?? loan.paidAmount);
        const remaining = Math.max(0, money(total - repaid));
        const type = loan.type === 'Advance' ? 'Salary Advance' : 'Loan';
        if (type === 'Salary Advance') advanceMonth = money(advanceMonth + thisMonthAmount);
        else loanMonth = money(loanMonth + thisMonthAmount);
        loanSchedule.push({
            type,
            original: formatAed(total),
            thisMonth: formatAed(thisMonthAmount),
            paidToDate: formatAed(repaid),
            remaining: formatAed(remaining),
            schedule: duration ? `${formatAed(money(total / Math.max(1, Number(duration) || 1)))} x ${duration} months` : '—',
            thisMonthAmount,
        });
    }
    if (!loanSchedule.some((row) => row.type === 'Salary Advance')) loanSchedule.unshift(emptyLoanRow('Salary Advance'));
    if (!loanSchedule.some((row) => row.type === 'Loan')) loanSchedule.push(emptyLoanRow('Loan'));

    let fineMonth = 0;
    const fineRows = [];
    for (const fine of fines || []) {
        const duration = Math.max(1, Number(fine.originalPayableDuration ?? fine.payableDuration) || 1);
        const startFineYm = toYearMonth(fine.originalMonthStart || fine.monthStart || fine.awardedDate || fine.createdAt);
        if (!scheduleHasMonth(startFineYm, duration, ym)) continue;
        const payable = resolveEmployeeFinePayableAmount(fine, code);
        if (payable <= 0) continue;
        const thisMonthAmount = money(payable / duration);
        const paid = money(fine.paidAmount);
        const remaining = Math.max(0, money(payable - paid));
        fineMonth = money(fineMonth + thisMonthAmount);
        const typeLabel = String(fine.fineType || fine.subCategory || fine.category || 'Fine').trim() || 'Fine';
        fineRows.push({
            type: typeLabel,
            amount: formatAed(payable),
            schedule: `${formatAed(thisMonthAmount)} x ${duration} months`,
            thisMonth: formatAed(thisMonthAmount),
            paid: formatAed(paid),
            unpaidStatus: `${formatAed(remaining)} / ${remaining > 0.009 ? 'Active' : 'Paid'}`,
            thisMonthAmount,
        });
    }

    let utilityMonth = 0;
    const utilities = [];
    for (const bill of utilityBills || []) {
        if (monthKeyOf(bill.billMonth) !== ym && toYearMonth(bill.billMonth) !== ym) continue;
        const excess = Number(bill.employeeDiffAmount);
        const pay = Number(bill.employeePayAmount);
        const amount =
            Number.isFinite(excess) && excess > 0.009
                ? money(excess)
                : Number.isFinite(pay) && pay > 0.009
                    ? money(pay)
                    : 0;
        if (amount <= 0) continue;
        utilityMonth = money(utilityMonth + amount);
        utilities.push({
            details: String(bill.utilityType || 'Utility').trim() || 'Utility',
            amount: formatAed(amount),
            reason: String(bill.notes || 'Usage exceeded the approved monthly plan limit.').trim(),
            total: amount,
        });
    }

    const deductions = [
        { component: 'Authorized Leave', basis: qtyLabel(authorizedDeductionDays, 'day'), amount: authorizedAmount },
        { component: 'Unauthorized Leave', basis: qtyLabel(unauthorizedDays, 'day'), amount: unauthorizedAmount },
        { component: 'Annual Leave', basis: qtyLabel(annualDays, 'day'), amount: annualAmount },
        { component: 'Late Arrival', basis: qtyLabel(lateEvents, 'event'), amount: lateAmount },
        { component: 'Salary Advance', basis: 'Schedule', amount: advanceMonth },
        { component: 'Loan', basis: 'Monthly', amount: loanMonth },
    ];
    if (fineMonth > 0) {
        const firstFine = fineRows[0];
        deductions.push({
            component: firstFine?.type ? `Fine - ${firstFine.type}` : 'Fine',
            basis: 'Installment',
            amount: fineMonth,
        });
    } else {
        deductions.push({ component: 'Fine', basis: 'Installment', amount: 0 });
    }
    deductions.push({ component: 'Utility Excess', basis: utilities[0]?.details || 'Mobile', amount: utilityMonth });

    const grossEarnings = money(earnings.reduce((sum, row) => sum + money(row.amount), 0));
    const totalDeductions = money(deductions.reduce((sum, row) => sum + money(row.amount), 0));
    const netSalary = money(Math.max(0, grossEarnings - totalDeductions));
    const attendanceDeductionTotal = money(authorizedAmount + unauthorizedAmount + annualAmount + lateAmount);

    const attendanceDeductions = [
        {
            category: 'Authorized Leave',
            qty: qtyLabel(authorizedDeductionDays, 'day'),
            rate: formatAed(daily),
            calculation: authorizedDeductionDays > 0
                ? `${qtyLabel(authorizedDeductionDays, 'day')} x ${formatAed(daily)}`
                : 'No deduction for this month',
            total: authorizedAmount,
        },
        {
            category: 'Unauthorized Leave',
            qty: qtyLabel(unauthorizedDays, 'day'),
            rate: formatAed(daily),
            calculation: unauthorizedDays > 0
                ? `${qtyLabel(unauthorizedDays, 'day')} x ${formatAed(daily)}`
                : 'No deduction for this month',
            total: unauthorizedAmount,
        },
        {
            category: 'Annual Leave',
            qty: qtyLabel(annualDays, 'day'),
            rate: formatAed(annualDays > 0 ? daily : 0),
            calculation: annualDays > 0 ? 'Paid annual leave — no deduction' : 'No deduction for this month',
            total: annualAmount,
        },
        {
            category: 'Late Arrival',
            qty: qtyLabel(lateEvents, 'event'),
            rate: formatAed(lateRate),
            calculation: lateEvents > 0 && lateRate > 0
                ? `${qtyLabel(lateEvents, 'event')} x ${formatAed(lateRate)}`
                : 'No deduction for this month',
            total: lateAmount,
        },
    ];

    return {
        enabled: Boolean(profile?.salarySlip),
        logoDataUrl: getVegaLogoDataUrl(),
        companyName: companyNameOf(emp),
        companyLocation: 'Dubai, UAE',
        monthKey: ym,
        monthLabel: monthLabelOf(ym),
        slipRef: slipRefOf(ym, code),
        employeeName: personName(emp),
        employeeId: code,
        designation: String(emp.designation || '').trim() || '—',
        attendance: {
            holidays: qtyLabel(holidays, 'day'),
            workingDayLeaves: qtyLabel(workingDayLeaves, 'day'),
            presentDays: qtyLabel(presentDays, 'day'),
            holidaysWorked: qtyLabel(holidaysWorked, 'day'),
            overtimeHours: hoursLabel(otHours),
            calendarDays: qtyLabel(daysInMonth, 'day'),
            compOffLeave: qtyLabel(compOffDays, 'day'),
        },
        earnings,
        deductions,
        grossEarnings,
        totalDeductions,
        netSalary,
        amountInWords: amountInWordsAed(netSalary),
        paymentMethod: String(profile?.companyMolCode || '').trim() ? 'WPS / Bank Transfer' : 'Bank Transfer',
        paymentDate: paymentDateLabel(ym),
        currency: 'AED',
        attendanceDeductions,
        attendanceDeductionTotal,
        loanSchedule,
        fines: fineRows,
        utilities,
        reconciliation: {
            attendance: attendanceDeductionTotal,
            salaryAdvance: advanceMonth,
            loan: loanMonth,
            fine: fineMonth,
            utilityExcess: utilityMonth,
            verifiedTotal: totalDeductions,
        },
        fileName: `Salary-Slip-${ym}-${code}.pdf`,
    };
}
