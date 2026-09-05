import Attendance from '../models/Attendance.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import EmployeeSalary from '../models/EmployeeSalary.js';
import Fine from '../models/Fine.js';
import Holiday from '../models/Holiday.js';
import Loan from '../models/Loan.js';
import PartyExpense from '../models/PartyExpense.js';
import Reward from '../models/Reward.js';
import SalaryHistoricalProfile from '../models/SalaryHistoricalProfile.js';
import SalarySlipMonth from '../models/SalarySlipMonth.js';
import UtilityBillPayment from '../models/UtilityBillPayment.js';
import { isCompanyShellEmployee } from './attendanceEmployeeFilters.js';
import { resolveEmployeeFinePayableAmount } from './finePayableAmount.js';
import { getScheduledEmailTimeZone, getZonedParts } from './scheduleDailyAtMidnight.js';
import {
    clockTimeToMinutes,
    getScheduledPunchMinutes,
    getWeekForStaffType,
    holidayAppliesToStaff,
    loadWorkingTimeDoc,
} from './workingTimeHelpers.js';
import { getVegaLogoDataUrl } from './buildSalarySlipPdfHtml.js';
import { resolveEmployeePayrollPolicy } from './employeeLeavePolicy.js';

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

function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** YYYY-MM for loan/fine payable schedules (string, Date, or ISO). */
function payableMonthKey(value) {
    if (!value) return '';
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}`;
    }
    const fromText = monthKeyOf(value);
    if (fromText) return fromText;
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
        return `${parsed.getFullYear()}-${pad2(parsed.getMonth() + 1)}`;
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

function salaryMonthWindow(ym) {
    const key = monthKeyOf(ym);
    const days = lastDayOfMonth(key);
    return {
        ym: key,
        days,
        from: key ? `${key}-01` : '',
        to: key ? `${key}-${pad2(days)}` : '',
    };
}

function dateKeyOf(value) {
    const raw = String(value || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    return iso ? iso[1] : '';
}

function isDateInSalaryMonth(dateValue, ym) {
    const date = dateKeyOf(dateValue);
    const { from, to } = salaryMonthWindow(ym);
    return Boolean(date && from && to && date >= from && date <= to);
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
    return payableMonthKey(value);
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

function pickAmount(primary, fallback) {
    const fromPrimary = money(primary);
    if (fromPrimary > 0) return fromPrimary;
    return money(fallback);
}

/** History row for the slip month, with current salary-structure fields filled in. */
function resolvedSalaryEntry(salaryDoc, ym) {
    const history = historyEntryForMonth(salaryDoc, ym);
    if (!history) return salaryDoc || null;
    if (!salaryDoc || history === salaryDoc) return history;
    const histExtras = Array.isArray(history.additionalAllowances) ? history.additionalAllowances : [];
    const docExtras = Array.isArray(salaryDoc.additionalAllowances) ? salaryDoc.additionalAllowances : [];
    return {
        ...salaryDoc,
        ...history,
        basic: pickAmount(history.basic, salaryDoc.basic),
        houseRentAllowance: pickAmount(history.houseRentAllowance, salaryDoc.houseRentAllowance),
        otherAllowance: pickAmount(history.otherAllowance, salaryDoc.otherAllowance),
        vehicleAllowance: pickAmount(history.vehicleAllowance, salaryDoc.vehicleAllowance),
        fuelAllowance: pickAmount(history.fuelAllowance, salaryDoc.fuelAllowance),
        totalSalary: pickAmount(history.totalSalary, salaryDoc.totalSalary),
        monthlySalary: pickAmount(history.monthlySalary, salaryDoc.monthlySalary),
        additionalAllowances: histExtras.length ? histExtras : docExtras,
    };
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

function allowanceType(row) {
    return String(row?.type || '').trim().toLowerCase();
}

function isPhoneAllowance(row) {
    return /phone|mobile/.test(allowanceType(row));
}

function upsertEarning(rows, component, basis, amount) {
    const list = Array.isArray(rows) ? rows : [];
    const idx = list.findIndex((row) => String(row?.component || '').trim() === component);
    const next = { component, basis, amount: money(amount) };
    if (idx >= 0) {
        list[idx] = { ...list[idx], ...next };
        return list;
    }
    list.push(next);
    return list;
}

function structureEarnings(entry) {
    const extras = Array.isArray(entry?.additionalAllowances) ? entry.additionalAllowances : [];
    const extraHasVehicle = extras.some((row) => allowanceType(row).includes('vehicle'));
    const extraHasFuel = extras.some((row) => allowanceType(row).includes('fuel'));
    const phoneAmount = extras.filter(isPhoneAllowance).reduce((sum, row) => sum + money(row?.amount), 0);
    const vehicleFromExtras = extras
        .filter((row) => allowanceType(row).includes('vehicle'))
        .reduce((sum, row) => sum + money(row?.amount), 0);
    const fuelFromExtras = extras
        .filter((row) => allowanceType(row).includes('fuel'))
        .reduce((sum, row) => sum + money(row?.amount), 0);
    const leftoverExtras = extras.filter((row) => {
        const type = allowanceType(row);
        return !isPhoneAllowance(row) && !type.includes('vehicle') && !type.includes('fuel');
    });
    return [
        { component: 'Basic Salary', basis: 'Monthly', amount: money(entry?.basic) },
        { component: 'Other Allowance', basis: 'Monthly', amount: money(entry?.otherAllowance) },
        { component: 'House Rental Allowance', basis: 'Monthly', amount: money(entry?.houseRentAllowance) },
        { component: 'Vehicle Allowance', basis: 'Monthly', amount: extraHasVehicle ? vehicleFromExtras : money(entry?.vehicleAllowance) },
        { component: 'Fuel Allowance', basis: 'Monthly', amount: extraHasFuel ? fuelFromExtras : money(entry?.fuelAllowance) },
        { component: 'Phone Allowance', basis: 'Monthly', amount: phoneAmount },
        ...leftoverExtras
            .map((row) => ({
                component: String(row?.type || 'Allowance').trim() || 'Allowance',
                basis: 'Monthly',
                amount: money(row?.amount),
            }))
            .filter((row) => row.amount > 0),
    ];
}

function inCalendarYear(value, year) {
    const ym = payableMonthKey(value) || monthKeyOf(value);
    return Boolean(year && ym && ym.startsWith(`${year}-`));
}

export function yearlyEndOfServiceBenefit(basicMonthly, joiningDate, year) {
    const basic = money(basicMonthly);
    if (basic <= 0 || !year) return 0;
    const daily = money(basic / 30);
    const join = joiningDate ? new Date(joiningDate) : null;
    const asOf = new Date(year, 11, 31);
    if (!join || Number.isNaN(join.getTime()) || join > asOf) {
        return money(daily * 21);
    }
    const msYear = 365.25 * 24 * 60 * 60 * 1000;
    const years = (asOf.getTime() - join.getTime()) / msYear;
    const daysPerYear = years >= 5 ? 30 : 21;
    if (years < 1) {
        const start = join.getFullYear() === year ? join : new Date(year, 0, 1);
        const servedDays = Math.max(0, Math.round((asOf.getTime() - start.getTime()) / 86400000) + 1);
        const yearLen = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 366 : 365;
        return money(daily * 21 * Math.min(1, servedDays / yearLen));
    }
    return money(daily * daysPerYear);
}

export function monthlyEndOfServiceBenefit(basicMonthly, joiningDate, year) {
    return money(yearlyEndOfServiceBenefit(basicMonthly, joiningDate, year) / 12);
}

function isInactiveBenefitRow(row) {
    const status = String(row?.paymentStatus || row?.status || '').toLowerCase();
    return status === 'draft' || status === 'cancelled' || status === 'rejected';
}

function rowInYear(row, year, dateKeys) {
    return (dateKeys || []).some((key) => inCalendarYear(row?.[key], year));
}

function sumBenefitInYear(rows, year, { amountKeys, dateKeys, includeFlag } = {}) {
    let total = 0;
    for (const row of rows || []) {
        if (isInactiveBenefitRow(row)) continue;
        if (includeFlag && row[includeFlag] === false) continue;
        if (!rowInYear(row, year, dateKeys)) continue;
        for (const key of amountKeys || []) {
            total = money(total + money(row?.[key]));
        }
    }
    return total;
}

function structureYearlySalary(entry) {
    return structureEarnings(entry)
        .filter((row) => row.component !== 'Phone Allowance')
        .map((row) => ({
            component: row.component,
            basis: 'Monthly',
            amount: money(row.amount),
        }));
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

function lateMultiplierFromPolicy(lateInRules) {
    const rule = Array.isArray(lateInRules) ? lateInRules[0] : null;
    const deduct = String(rule?.deduct || '').trim().toLowerCase();
    if (deduct === 'full') return 1;
    if (deduct === 'half') return 0.5;
    if (deduct === 'quarter') return 0.25;
    return 0;
}

function policyTimes(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function cycleStatus(cycle) {
    return String(cycle?.paymentStatus || cycle?.status || '').trim().toLowerCase();
}

function cycleIsInactive(cycle) {
    return ['draft', 'cancelled', 'rejected'].includes(cycleStatus(cycle));
}

function cycleIsPaid(cycle) {
    return ['paid', 'completed'].includes(cycleStatus(cycle));
}

function benefitFromCycles(cycles, amountKeys, ym, dateKeys = []) {
    let pendingCount = 0;
    let pendingAmount = 0;
    let totalCount = 0;
    let totalAmount = 0;
    for (const cycle of cycles || []) {
        if (cycleIsInactive(cycle)) continue;
        if (ym) {
            const keys = dateKeys.length ? dateKeys : ['paymentDate'];
            const inMonth = keys.some((key) => cycleInMonth(cycle?.[key], ym));
            if (!inMonth) continue;
        }
        const amt = amountKeys.reduce((sum, key) => sum + money(cycle?.[key]), 0);
        if (amt <= 0) continue;
        totalCount += 1;
        totalAmount += amt;
        if (!cycleIsPaid(cycle)) {
            pendingCount += 1;
            pendingAmount += amt;
        }
    }
    if (pendingCount > 0) {
        return { count: pendingCount, amount: money(pendingAmount) };
    }
    return { count: totalCount, amount: money(totalAmount) };
}

function installmentTimes(rows, readAmount) {
    const list = (Array.isArray(rows) ? rows : []).filter((row) => money(readAmount(row)) > 0);
    if (list.length === 1) {
        const match = String(list[0]?.schedule || '').match(/x\s+(\d+)/i);
        if (match) return Number(match[1]) || 0;
        const duration = Number(list[0]?.duration);
        if (Number.isFinite(duration) && duration > 0) return duration;
        return 1;
    }
    return list.length;
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
    const start = payableMonthKey(startYm);
    const target = payableMonthKey(ym);
    if (!start || !target) return false;
    for (let i = 0; i < months; i += 1) {
        if (addMonthsYm(start, i) === target) return true;
    }
    return false;
}

function isEmployeeUnpaidStatus(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return true;
    if (raw === 'paid' || raw === 'completed') return false;
    return true;
}

function unpaidInstallmentForMonth(exp, ym) {
    if (!exp || !isEmployeeUnpaidStatus(exp.status)) return 0;
    const target = payableMonthKey(ym);
    const parts = Array.isArray(exp.installments) ? exp.installments : [];
    if (parts.length) {
        const part = parts.find((row) => payableMonthKey(row.monthKey) === target);
        if (!part || !isEmployeeUnpaidStatus(part.status)) return 0;
        return money(part.amount);
    }
    const expMonth = payableMonthKey(exp.billMonth || exp.monthStart);
    if (!expMonth || expMonth !== target) return 0;
    return money(exp.amount);
}

function unpaidSchedulePortion({ total, repaid, startYm, duration, ym }) {
    const start = payableMonthKey(startYm);
    const target = payableMonthKey(ym);
    const months = Math.max(1, Number(duration) || 1);
    const due = money(total);
    if (!start || !target || due <= 0 || !scheduleHasMonth(start, months, target)) return 0;
    let paidLeft = Math.max(0, money(repaid));
    const base = money(due / months);
    let allocated = 0;
    for (let i = 0; i < months; i += 1) {
        const key = addMonthsYm(start, i);
        const portion = i === months - 1 ? money(due - allocated) : base;
        allocated = money(allocated + portion);
        const paidHere = Math.min(paidLeft, portion);
        paidLeft = money(paidLeft - paidHere);
        const unpaid = money(portion - paidHere);
        if (key === target) return unpaid;
    }
    return 0;
}

function unpaidThisMonthFromPartyOrSchedule(party, schedule) {
    if (party && !isEmployeeUnpaidStatus(party.status)) return 0;
    const fromParty = unpaidInstallmentForMonth(party, schedule.ym);
    if (fromParty > 0) return fromParty;
    if (Array.isArray(party?.installments) && party.installments.length > 0) return 0;
    return unpaidSchedulePortion(schedule);
}

function partyExpenseFor(expenses, { kind, mongoField, mongoId } = {}) {
    const wantId = mongoId ? String(mongoId) : '';
    return (expenses || []).find((exp) => {
        if (kind && exp.kind !== kind) return false;
        if (wantId && String(exp[mongoField] || '') !== wantId) return false;
        return true;
    }) || null;
}

function employeeExcessAmount(bill) {
    if (String(bill?.paymentBy || '').toLowerCase() === 'company') return 0;
    const excess = Number(bill?.employeeDiffAmount);
    return Number.isFinite(excess) && excess > 0.009 ? money(excess) : 0;
}

function employeeExcessThisMonth(bill, ym) {
    if (payableMonthKey(bill?.billMonth) !== payableMonthKey(ym)) return 0;
    return employeeExcessAmount(bill);
}

function isApprovedAssignee(assignee) {
    const status = String(assignee?.approvalStatus || '').trim();
    if (!status) return true;
    return status === 'Approved';
}

function paidFromPartyExpense(exp) {
    if (!exp) return 0;
    if (!isEmployeeUnpaidStatus(exp.status)) return money(exp.amount);
    const parts = Array.isArray(exp.installments) ? exp.installments : [];
    return money(
        parts.reduce((sum, part) => sum + (isEmployeeUnpaidStatus(part.status) ? 0 : money(part.amount)), 0),
    );
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
        originalAmount: 0,
        paidAmount: 0,
        remainingAmount: 0,
        approved: false,
    };
}

/**
 * Build the VEGA salary-slip view model for one employee and YYYY-MM.
 */
export async function buildSalarySlipPayload({
    employeeId,
    monthKey,
    emp: preloadedEmp,
    salaryDoc: preloadedSalary,
    skipOverride = false,
} = {}) {
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
    const monthWindow = salaryMonthWindow(ym);
    const daysInMonth = monthWindow.days;
    const from = monthWindow.from;
    const to = monthWindow.to;
    const idPattern = new RegExp(`^${escapeRegex(code)}$`, 'i');

    const [salaryDoc, profile, policy, workingTime, attendance, holidayDocs, loans, fines, rewards, utilityBills, partyExpenses] =
        await Promise.all([
            preloadedSalary ||
                EmployeeSalary.findOne({ employeeId: idPattern })
                    .select('-offerLetter.data -salaryHistory.attachment.data -salaryHistory.offerLetter.data')
                    .lean(),
            SalaryHistoricalProfile.findOne({ employeeId: idPattern })
                .select('salarySlip companyMolCode paymentCycles annualLeaveRecords leaveRecords')
                .lean(),
            resolveEmployeePayrollPolicy(emp),
            loadWorkingTimeDoc(),
            Attendance.find({
                $or: [{ employeeMongoId: mongoId }, { employeeId: idPattern }],
                date: { $gte: from, $lte: to },
            })
                .select('date statusKey leavePayType timeIn timeOut')
                .lean(),
            Holiday.find({ date: { $gte: from, $lte: to } }).select('date appliesTo').lean(),
            Loan.find({
                $and: [
                    { $or: [{ employeeId: idPattern }, { employeeObjectId: emp._id }] },
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
                assignedEmployees: { $elemMatch: { employeeId: idPattern } },
            })
                .select('fineType subCategory category assignedEmployees employeeAmount companyAmount serviceCharge discount totalFineAmount fineAmount fineStatus sourceOfIncome payableDuration monthStart originalMonthStart originalPayableDuration responsibleFor awardedDate createdAt paidAmount')
                .lean(),
            Reward.find({
                employeeId: idPattern,
                $or: [
                    { rewardStatus: { $in: APPROVED_REWARD_STATUSES } },
                    { approvalStatus: { $in: APPROVED_REWARD_STATUSES } },
                ],
            })
                .select('amount awardedDate approvedDate rewardStatus rewardType')
                .lean(),
            UtilityBillPayment.find({
                payByEmployeeId: idPattern,
                status: { $in: ['Approved', 'Paid'] },
            })
                .select('utilityType billMonth employeePayAmount employeeDiffAmount paymentBy notes status')
                .lean(),
            PartyExpense.find({
                partyType: 'employee',
                employeeId: idPattern,
                kind: { $in: ['loan', 'advance', 'fine', 'balance'] },
            })
                .select('kind amount duration monthStart billMonth status installments loanMongoId fineMongoId utilityBillId utilityType')
                .lean(),
        ]);

    const entry = resolvedSalaryEntry(salaryDoc, ym);
    const monthly = monthlySalaryOf(entry);
    const daily = monthly > 0 && daysInMonth > 0 ? money(monthly / daysInMonth) : 0;
    const authTimes = policyTimes(policy?.authorizedLeaveDeductionDays, 1);
    const unauthTimes = policyTimes(policy?.unauthorizedLeaveDeductionDays, 2);
    const lateTimes = lateMultiplierFromPolicy(policy?.lateInRules);
    const week = getWeekForStaffType(workingTime, emp.staffType);
    const holidaySet = new Set(
        (holidayDocs || [])
            .filter((row) => holidayAppliesToStaff(row, emp.staffType))
            .map((row) => dateKeyOf(row.date))
            .filter((date) => isDateInSalaryMonth(date, ym)),
    );

    let presentDays = 0;
    let workingDayLeaves = 0;
    let authorizedDays = 0;
    let unauthorizedDays = 0;
    let sickDays = 0;
    let unpaidSickDays = 0;
    let annualDays = 0;
    let lateEvents = 0;
    let holidayMarks = 0;
    let holidaysWorked = 0;
    let compOffDays = 0;
    let otHours = 0;
    let otDays = 0;
    const countedDates = new Set();

    for (const row of attendance || []) {
        const date = dateKeyOf(row.date);
        if (!isDateInSalaryMonth(date, ym) || countedDates.has(date)) continue;
        countedDates.add(date);
        const key = String(row.statusKey || '');
        if (key === 'holiday') holidayMarks += 1;
        if (key === 'compoff_leave') compOffDays += 1;
        if (key === 'late_arrived') lateEvents += 1;
        if (PRESENT_KEYS.has(key)) presentDays += 1;
        if (LEAVE_KEYS.has(key)) workingDayLeaves += 1;
        if (key === 'authorized_leave') authorizedDays += 1;
        if (key === 'unauthorized_leave') unauthorizedDays += 1;
        if (key === 'sick_leave') {
            sickDays += 1;
            if (String(row.leavePayType || '').toLowerCase() === 'unpaid') unpaidSickDays += 1;
        }
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
        } else {
            otHours += ot.hours;
        }
    }

    const holidays = Math.max(holidaySet.size, holidayMarks);
    const authorizedDeductionDays = authorizedDays;
    const otHoursAmount = money((daily / 10) * otHours);
    const otDaysAmount = money(daily * otDays);
    const authorizedAmount = money(daily * authTimes * authorizedDeductionDays);
    const unauthorizedAmount = money(daily * unauthTimes * unauthorizedDays);
    const sickAmount = money(daily * unpaidSickDays);
    const annualAmount = 0;
    const lateAmount = money(daily * lateTimes * lateEvents);

    const earnings = structureEarnings(entry);
    upsertEarning(
        earnings,
        'Overtime Hours',
        hoursLabel(otHours).replace(/ hours?$/, ' h'),
        otHoursAmount,
    );
    upsertEarning(earnings, 'Overtime Days', qtyLabel(otDays, 'day'), otDaysAmount);

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
    upsertEarning(
        earnings,
        'Leave Salary',
        leaveSalaryDays > 0 ? qtyLabel(leaveSalaryDays, 'day') : 'Annual',
        leaveSalaryAmount,
    );
    upsertEarning(earnings, 'Ticket', 'Annual', ticketAmount);

    let rewardAmount = 0;
    let rewardCount = 0;
    for (const reward of rewards || []) {
        const when = toYearMonth(reward.awardedDate || reward.approvedDate);
        if (when !== ym) continue;
        if (String(reward.rewardType || '') === 'Certificate') continue;
        rewardCount += 1;
        rewardAmount = money(rewardAmount + money(reward.amount));
    }
    upsertEarning(earnings, 'Reward', rewardCount > 0 ? 'Reward scheduled' : 'Approved', rewardAmount);

    const slipYear = Number(String(ym).slice(0, 4));
    let yearlyRewardAmount = 0;
    for (const reward of rewards || []) {
        const when = reward.awardedDate || reward.approvedDate;
        if (!inCalendarYear(when, slipYear)) continue;
        if (String(reward.rewardType || '') === 'Certificate') continue;
        yearlyRewardAmount = money(yearlyRewardAmount + money(reward.amount));
    }
    const leaveSalaryDateKeys = [
        'leaveSalaryPaymentDate',
        'paymentDate',
        'eligibilityEndDate',
        'eligibilityStartDate',
        'startDate',
        'endDate',
        'fromDate',
        'toDate',
    ];
    const travelDateKeys = [
        'ticketPaymentDate',
        'paymentDate',
        'eligibilityEndDate',
        'eligibilityStartDate',
        'startDate',
        'endDate',
        'fromDate',
        'toDate',
    ];
    let yearlyLeaveSalaryAmount = sumBenefitInYear(profile?.paymentCycles, slipYear, {
        amountKeys: ['leaveSalaryAmount', 'leaveSalary'],
        dateKeys: leaveSalaryDateKeys,
    });
    if (yearlyLeaveSalaryAmount <= 0) {
        yearlyLeaveSalaryAmount = money(
            sumBenefitInYear(profile?.annualLeaveRecords, slipYear, {
                amountKeys: ['leaveSalaryAmount', 'leaveSalary'],
                dateKeys: leaveSalaryDateKeys,
                includeFlag: 'includeLeave',
            }) +
                sumBenefitInYear(profile?.leaveRecords, slipYear, {
                    amountKeys: ['leaveSalaryAmount', 'leaveSalary'],
                    dateKeys: leaveSalaryDateKeys,
                    includeFlag: 'includeLeave',
                }),
        );
    }
    let yearlyTravelAmount = sumBenefitInYear(profile?.paymentCycles, slipYear, {
        amountKeys: ['ticketAmount'],
        dateKeys: travelDateKeys,
    });
    if (yearlyTravelAmount <= 0) {
        yearlyTravelAmount = money(
            sumBenefitInYear(profile?.annualLeaveRecords, slipYear, {
                amountKeys: ['ticketAmount'],
                dateKeys: travelDateKeys,
                includeFlag: 'includeTicket',
            }) +
                sumBenefitInYear(profile?.leaveRecords, slipYear, {
                    amountKeys: ['ticketAmount'],
                    dateKeys: travelDateKeys,
                    includeFlag: 'includeTicket',
                }),
        );
    }
    const yearlyEarnings = [
        ...structureYearlySalary(entry),
        { component: 'Reward', basis: 'Yearly', amount: yearlyRewardAmount },
        {
            component: 'End of Service Benefit(yearly)',
            basis: 'Yearly',
            amount: yearlyEndOfServiceBenefit(entry?.basic, emp.dateOfJoining, slipYear),
        },
        { component: 'Leave Salary', basis: 'Yearly', amount: yearlyLeaveSalaryAmount },
        { component: 'Travel Allowance', basis: 'Yearly', amount: yearlyTravelAmount },
    ];
    const yearlyGrossEarnings = money(yearlyEarnings.reduce((sum, row) => sum + money(row.amount), 0));

    let advanceMonth = 0;
    let loanMonth = 0;
    const loanSchedule = [];
    const countedLoanIds = new Set();
    const countedFineIds = new Set();
    const countedUtilityIds = new Set();
    const codeKey = code.toLowerCase();

    for (const loan of loans || []) {
        const duration = loan.originalDuration ?? loan.duration;
        const start =
            payableMonthKey(loan.originalMonthStart || loan.monthStart) ||
            payableMonthKey(loan.approvedDate || loan.appliedDate);
        const isAdvance = /advance/i.test(String(loan.type || ''));
        const kind = isAdvance ? 'advance' : 'loan';
        const party = partyExpenseFor(partyExpenses, {
            kind,
            mongoField: 'loanMongoId',
            mongoId: loan._id,
        });
        const total = money(loan.amount);
        const repaid = money(loan.repaidAmount);
        const thisMonthAmount = unpaidThisMonthFromPartyOrSchedule(party, {
            total,
            repaid,
            startYm: start,
            duration,
            ym,
        });
        const remaining = Math.max(0, money(total - repaid));
        const type = isAdvance ? 'Salary Advance' : 'Loan';
        countedLoanIds.add(String(loan._id || ''));
        if (thisMonthAmount > 0) {
            if (type === 'Salary Advance') advanceMonth = money(advanceMonth + thisMonthAmount);
            else loanMonth = money(loanMonth + thisMonthAmount);
        }
        loanSchedule.push({
            type,
            original: formatAed(total),
            thisMonth: formatAed(thisMonthAmount),
            paidToDate: formatAed(repaid),
            remaining: formatAed(remaining),
            schedule: duration ? `${formatAed(money(total / Math.max(1, Number(duration) || 1)))} x ${duration} months` : '—',
            thisMonthAmount,
            originalAmount: total,
            paidAmount: repaid,
            remainingAmount: remaining,
            approved: true,
        });
    }

    let fineMonth = 0;
    const fineRows = [];
    for (const fine of fines || []) {
        const assignee = (fine.assignedEmployees || []).find((ae) => {
            const id = String(ae?.employeeId || '').trim();
            if (!id || ['VEGA-HR-0000', 'VEGA_INTERNAL', 'PENDING'].includes(id)) return false;
            return id.toLowerCase() === codeKey;
        });
        if (!assignee || !isApprovedAssignee(assignee)) continue;
        const duration = Math.max(1, Number(fine.originalPayableDuration ?? fine.payableDuration) || 1);
        const startFineYm =
            payableMonthKey(fine.originalMonthStart || fine.monthStart) ||
            payableMonthKey(fine.awardedDate || fine.approvedDate || fine.createdAt);
        const payable = resolveEmployeeFinePayableAmount(fine, assignee.employeeId);
        if (payable <= 0) continue;
        const party = partyExpenseFor(partyExpenses, {
            kind: 'fine',
            mongoField: 'fineMongoId',
            mongoId: fine._id,
        });
        const paid = money(fine.paidAmount);
        const thisMonthAmount = unpaidThisMonthFromPartyOrSchedule(party, {
            total: payable,
            repaid: paid,
            startYm: startFineYm,
            duration,
            ym,
        });
        const remaining = Math.max(0, money(payable - paid));
        const installment = money(payable / duration);
        countedFineIds.add(String(fine._id || ''));
        if (thisMonthAmount > 0) fineMonth = money(fineMonth + thisMonthAmount);
        const typeLabel = String(fine.fineType || fine.subCategory || fine.category || 'Fine').trim() || 'Fine';
        fineRows.push({
            type: typeLabel,
            amount: formatAed(payable),
            schedule: `${formatAed(installment)} x ${duration} months`,
            thisMonth: formatAed(thisMonthAmount),
            paid: formatAed(paid),
            unpaidStatus: `${formatAed(remaining)} / ${remaining > 0.009 ? 'Not Paid' : 'Paid'}`,
            thisMonthAmount,
            originalAmount: payable,
            paidAmount: paid,
            remainingAmount: remaining,
            approved: true,
        });
    }

    let utilityMonth = 0;
    const utilities = [];
    for (const exp of partyExpenses || []) {
        if (exp.kind === 'balance') continue;
        const thisMonthAmount = unpaidInstallmentForMonth(exp, ym);
        const total = money(exp.amount);
        if (total <= 0 && thisMonthAmount <= 0) continue;
        const paid = paidFromPartyExpense(exp);
        const remaining = Math.max(0, money(total - paid));
        if (exp.kind === 'fine') {
            if (countedFineIds.has(String(exp.fineMongoId || ''))) continue;
            countedFineIds.add(String(exp.fineMongoId || ''));
            if (thisMonthAmount > 0) fineMonth = money(fineMonth + thisMonthAmount);
            fineRows.push({
                type: 'Fine',
                amount: formatAed(total),
                schedule: `${formatAed(thisMonthAmount || total)} x ${Math.max(1, Number(exp.duration) || 1)} months`,
                thisMonth: formatAed(thisMonthAmount),
                paid: formatAed(paid),
                unpaidStatus: `${formatAed(remaining)} / ${remaining > 0.009 ? 'Not Paid' : 'Paid'}`,
                thisMonthAmount,
                originalAmount: total,
                paidAmount: paid,
                remainingAmount: remaining,
                approved: true,
            });
            continue;
        }
        if (exp.kind === 'loan' || exp.kind === 'advance') {
            if (countedLoanIds.has(String(exp.loanMongoId || ''))) continue;
            countedLoanIds.add(String(exp.loanMongoId || ''));
            const isAdvance = exp.kind === 'advance';
            if (thisMonthAmount > 0) {
                if (isAdvance) advanceMonth = money(advanceMonth + thisMonthAmount);
                else loanMonth = money(loanMonth + thisMonthAmount);
            }
            loanSchedule.push({
                type: isAdvance ? 'Salary Advance' : 'Loan',
                original: formatAed(total),
                thisMonth: formatAed(thisMonthAmount),
                paidToDate: formatAed(paid),
                remaining: formatAed(remaining),
                schedule: `${formatAed(thisMonthAmount || total)} x ${Math.max(1, Number(exp.duration) || 1)} months`,
                thisMonthAmount,
                originalAmount: total,
                paidAmount: paid,
                remainingAmount: remaining,
                approved: true,
            });
        }
    }

    if (!loanSchedule.some((row) => row.type === 'Salary Advance')) loanSchedule.unshift(emptyLoanRow('Salary Advance'));
    if (!loanSchedule.some((row) => row.type === 'Loan')) loanSchedule.push(emptyLoanRow('Loan'));

    for (const bill of utilityBills || []) {
        const billId = String(bill._id || '');
        const total = employeeExcessAmount(bill);
        if (total <= 0) continue;
        if (billId && countedUtilityIds.has(billId)) continue;
        if (billId) countedUtilityIds.add(billId);
        const party = partyExpenseFor(partyExpenses, {
            kind: 'balance',
            mongoField: 'utilityBillId',
            mongoId: bill._id,
        });
        const paid = paidFromPartyExpense(party);
        const thisMonthAmount = unpaidInstallmentForMonth(party, ym) || (paid > 0 ? 0 : employeeExcessThisMonth(bill, ym));
        if (thisMonthAmount > 0) utilityMonth = money(utilityMonth + thisMonthAmount);
        utilities.push({
            details: String(bill.utilityType || 'Utility').trim() || 'Utility',
            amount: formatAed(total),
            reason: String(bill.notes || 'Usage exceeded the approved monthly plan limit.').trim(),
            total,
            paid,
            thisMonthAmount,
            thisMonth: formatAed(thisMonthAmount),
            approved: true,
        });
    }

    for (const exp of partyExpenses || []) {
        if (exp.kind !== 'balance') continue;
        const billId = String(exp.utilityBillId || '');
        if (billId && countedUtilityIds.has(billId)) continue;
        const total = money(exp.amount);
        const thisMonthAmount = unpaidInstallmentForMonth(exp, ym);
        if (total <= 0 && thisMonthAmount <= 0) continue;
        if (billId) countedUtilityIds.add(billId);
        const paid = paidFromPartyExpense(exp);
        if (thisMonthAmount > 0) utilityMonth = money(utilityMonth + thisMonthAmount);
        utilities.push({
            details: String(exp.utilityType || 'Utility').trim() || 'Utility',
            amount: formatAed(total),
            reason: 'Employee excess',
            total,
            paid,
            thisMonthAmount,
            thisMonth: formatAed(thisMonthAmount),
            approved: true,
        });
    }

    const deductions = [
        { component: 'Authorized Leave', basis: qtyLabel(authorizedDeductionDays, 'day'), amount: authorizedAmount },
        { component: 'Unauthorized Leave', basis: qtyLabel(unauthorizedDays, 'day'), amount: unauthorizedAmount },
        { component: 'Sick Leave', basis: qtyLabel(sickDays, 'day'), amount: sickAmount },
        { component: 'Annual Leave', basis: qtyLabel(annualDays, 'day'), amount: annualAmount },
        { component: 'Late Arrival', basis: qtyLabel(lateEvents, 'event'), amount: lateAmount },
        { component: 'Salary Advance', basis: 'Schedule', amount: advanceMonth },
        { component: 'Loan', basis: 'Monthly', amount: loanMonth },
        { component: 'Fine', basis: 'Installment', amount: fineMonth },
        { component: 'Utility Excess', basis: utilities[0]?.details || 'Mobile', amount: utilityMonth },
    ];

    const grossEarnings = money(earnings.reduce((sum, row) => sum + money(row.amount), 0));
    const totalDeductions = money(deductions.reduce((sum, row) => sum + money(row.amount), 0));
    const netSalary = money(Math.max(0, grossEarnings - totalDeductions));
    const attendanceDeductionTotal = money(
        authorizedAmount + unauthorizedAmount + sickAmount + annualAmount + lateAmount,
    );

    const attendanceDeductions = [
        {
            category: 'Authorized Leave',
            qty: qtyLabel(authorizedDeductionDays, 'day'),
            rate: formatAed(money(daily * authTimes)),
            calculation: authorizedDeductionDays > 0
                ? `${qtyLabel(authorizedDeductionDays, 'day')} x ${authTimes} x ${formatAed(daily)}`
                : 'No deduction for this month',
            total: authorizedAmount,
        },
        {
            category: 'Unauthorized Leave',
            qty: qtyLabel(unauthorizedDays, 'day'),
            rate: formatAed(money(daily * unauthTimes)),
            calculation: unauthorizedDays > 0
                ? `${qtyLabel(unauthorizedDays, 'day')} x ${unauthTimes} x ${formatAed(daily)}`
                : 'No deduction for this month',
            total: unauthorizedAmount,
        },
        {
            category: 'Sick Leave',
            qty: qtyLabel(sickDays, 'day'),
            rate: formatAed(daily),
            calculation: unpaidSickDays > 0
                ? `${qtyLabel(unpaidSickDays, 'day')} unpaid x ${formatAed(daily)}`
                : sickDays > 0
                    ? 'Paid sick leave — no deduction'
                    : 'No deduction for this month',
            total: sickAmount,
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
            rate: formatAed(money(daily * lateTimes)),
            calculation: lateEvents > 0 && lateTimes > 0
                ? `${qtyLabel(lateEvents, 'event')} x ${lateTimes} x ${formatAed(daily)}`
                : 'No deduction for this month',
            total: lateAmount,
        },
    ];

    const payload = {
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
        yearlyEarnings,
        yearlyGrossEarnings,
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
        summary: {
            monthDays: daysInMonth,
            monthlySalary: monthly,
            daySalary: daily,
            overtimeHoursCount: money(otHours),
            overtimeDaysCount: otDays,
            rewardCount,
            leaveSalary: benefitFromCycles(
                profile?.paymentCycles,
                ['leaveSalaryAmount', 'leaveSalary'],
                ym,
                ['leaveSalaryPaymentDate', 'paymentDate'],
            ),
            airTicket: benefitFromCycles(
                profile?.paymentCycles,
                ['ticketAmount'],
                ym,
                ['ticketPaymentDate', 'paymentDate'],
            ),
            leaveMultipliers: {
                authorized: authTimes,
                unauthorized: unauthTimes,
                annual: 1,
                late: lateTimes,
            },
            lossOfPayDays: {
                authorized: authorizedDeductionDays,
                unauthorized: unauthorizedDays,
                late: lateEvents,
                annual: annualDays,
                compOff: compOffDays,
            },
            otherDeductionTimes: {
                loan: installmentTimes(
                    loanSchedule.filter((row) => !/advance/i.test(String(row.type || ''))),
                    (row) => row.thisMonthAmount,
                ),
                fine: installmentTimes(fineRows, (row) => row.thisMonthAmount),
                utilityExcess: installmentTimes(utilities, (row) => row.total ?? row.amount),
                salaryAdvance: installmentTimes(
                    loanSchedule.filter((row) => /advance/i.test(String(row.type || ''))),
                    (row) => row.thisMonthAmount,
                ),
            },
        },
        fileName: `Salary-Slip-${ym}-${code}.pdf`,
    };

    if (!skipOverride) {
        try {
            const stored = await SalarySlipMonth.findOne({ employeeId: code, monthKey: ym })
                .select('slip')
                .lean();
            if (stored?.slip) {
                return preferLiveComputed(applySalarySlipOverride(payload, stored.slip), payload);
            }
        } catch (error) {
            console.error('[buildSalarySlipPayload] override', error?.message || error);
        }
    }
    return payload;
}

export function serializeSalarySlipForClient(slip) {
    if (!slip) return null;
    const { logoDataUrl, ...rest } = slip;
    return rest;
}

function rowNameKey(row) {
    const raw = String(row?.component || row?.type || '').trim().toLowerCase();
    if (raw.includes('end of service') || raw.includes('gratuity') || raw === 'eosb') {
        return 'end of service benefit';
    }
    return raw;
}

function mergeAmountRows(stored, live) {
    const liveRows = Array.isArray(live) ? live : [];
    const storedRows = Array.isArray(stored) ? stored : [];
    const storedByKey = new Map(storedRows.map((row) => [rowNameKey(row), row]));
    const used = new Set();
    const merged = liveRows.map((liveRow) => {
        const key = rowNameKey(liveRow);
        used.add(key);
        const storedRow = storedByKey.get(key);
        if (!storedRow) return liveRow;
        return {
            ...storedRow,
            ...liveRow,
            basis: liveRow.basis || storedRow.basis,
            amount: money(liveRow.amount),
        };
    });
    for (const row of storedRows) {
        if (!used.has(rowNameKey(row))) merged.push(row);
    }
    return merged;
}

function preferLiveComputed(merged, live) {
    if (!merged) return live;
    if (!live) return merged;
    return recalcSalarySlip({
        ...merged,
        earnings: mergeAmountRows(merged.earnings, live.earnings),
        yearlyEarnings: mergeAmountRows(merged.yearlyEarnings, live.yearlyEarnings),
        deductions: mergeAmountRows(merged.deductions, live.deductions),
        attendance: { ...(merged.attendance || {}), ...(live.attendance || {}) },
        loanSchedule: Array.isArray(live.loanSchedule) ? live.loanSchedule : merged.loanSchedule,
        fines: Array.isArray(live.fines) ? live.fines : merged.fines,
        utilities: Array.isArray(live.utilities) ? live.utilities : merged.utilities,
        attendanceDeductions: Array.isArray(live.attendanceDeductions)
            ? live.attendanceDeductions
            : merged.attendanceDeductions,
        summary: live.summary || merged.summary,
    });
}

function deductionKey(name) {
    return String(name || '').trim().toLowerCase();
}

function deductionMatches(component, name) {
    const a = deductionKey(component);
    const b = deductionKey(name);
    if (!a || !b) return false;
    if (a === b) return true;
    if (b === 'fine' && a.startsWith('fine')) return true;
    if (b === 'utility excess' && a.includes('utility')) return true;
    if (b === 'sick leave' && (a === 'sick' || a.startsWith('sick'))) return true;
    if (b === 'phone allowance' && a.includes('phone')) return true;
    return false;
}

function setDeductionAmount(rows, name, amount) {
    const list = Array.isArray(rows) ? rows.map((row) => ({ ...row })) : [];
    const idx = list.findIndex((row) => deductionMatches(row.component, name));
    if (idx >= 0) {
        list[idx] = { ...list[idx], amount: money(amount) };
        return list;
    }
    return list;
}

function pushDetailsIntoDeductions(slip) {
    let deductions = Array.isArray(slip.deductions) ? slip.deductions.map((row) => ({ ...row })) : [];
    for (const row of slip.attendanceDeductions || []) {
        deductions = setDeductionAmount(deductions, row.category, row.total);
    }
    for (const loan of slip.loanSchedule || []) {
        deductions = setDeductionAmount(deductions, loan.type, loan.thisMonthAmount ?? loan.thisMonth);
    }
    const fineTotal = (slip.fines || []).reduce(
        (sum, row) => sum + money(row.thisMonthAmount ?? row.thisMonth),
        0,
    );
    if (fineTotal > 0 || (slip.fines || []).length) {
        deductions = setDeductionAmount(deductions, 'Fine', fineTotal);
    }
    const utilTotal = (slip.utilities || []).reduce((sum, row) => sum + money(row.total ?? row.amount), 0);
    deductions = setDeductionAmount(deductions, 'Utility Excess', utilTotal);
    return { ...slip, deductions };
}

/**
 * Recompute totals that depend on earnings / deductions / detail rows.
 */
export function recalcSalarySlip(slip) {
    if (!slip) return slip;
    const earnings = (slip.earnings || []).map((row) => ({ ...row, amount: money(row.amount) }));
    const yearlyEarnings = (slip.yearlyEarnings || []).map((row) => ({
        ...row,
        amount: money(row.amount),
    }));
    const deductions = (slip.deductions || []).map((row) => ({ ...row, amount: money(row.amount) }));
    const grossEarnings = money(earnings.reduce((sum, row) => sum + money(row.amount), 0));
    const yearlyGrossEarnings = money(yearlyEarnings.reduce((sum, row) => sum + money(row.amount), 0));
    const totalDeductions = money(deductions.reduce((sum, row) => sum + money(row.amount), 0));
    const netSalary = money(Math.max(0, grossEarnings - totalDeductions));
    const attendanceDeductions = (slip.attendanceDeductions || []).map((row) => ({
        ...row,
        total: money(row.total),
    }));
    const attendanceDeductionTotal = money(
        attendanceDeductions.reduce((sum, row) => sum + money(row.total), 0),
    );
    const loanSchedule = (slip.loanSchedule || []).map((row) => {
        const thisMonthAmount = money(row.thisMonthAmount ?? row.thisMonth);
        return { ...row, thisMonthAmount, thisMonth: formatAed(thisMonthAmount) };
    });
    const fines = (slip.fines || []).map((row) => {
        const thisMonthAmount = money(row.thisMonthAmount ?? row.thisMonth);
        return { ...row, thisMonthAmount, thisMonth: formatAed(thisMonthAmount) };
    });
    const utilities = (slip.utilities || []).map((row) => {
        const total = money(row.total ?? row.amount);
        return { ...row, total, amount: row.amount || formatAed(total) };
    });
    const salaryAdvance = money(
        loanSchedule
            .filter((row) => /advance/i.test(String(row.type || '')))
            .reduce((sum, row) => sum + money(row.thisMonthAmount), 0),
    );
    const loan = money(
        loanSchedule
            .filter((row) => !/advance/i.test(String(row.type || '')))
            .reduce((sum, row) => sum + money(row.thisMonthAmount), 0),
    );
    const fine = money(fines.reduce((sum, row) => sum + money(row.thisMonthAmount), 0));
    const utilityExcess = money(utilities.reduce((sum, row) => sum + money(row.total), 0));
    return {
        ...slip,
        earnings,
        yearlyEarnings,
        yearlyGrossEarnings,
        deductions,
        attendanceDeductions,
        attendanceDeductionTotal,
        loanSchedule,
        fines,
        utilities,
        grossEarnings,
        totalDeductions,
        netSalary,
        amountInWords: amountInWordsAed(netSalary),
        reconciliation: {
            attendance: attendanceDeductionTotal,
            salaryAdvance,
            loan,
            fine,
            utilityExcess,
            verifiedTotal: totalDeductions,
        },
    };
}

export function applySalarySlipOverride(live, stored) {
    if (!live) return stored || null;
    if (!stored) return live;
    const merged = {
        ...live,
        attendance: { ...(live.attendance || {}), ...(stored.attendance || {}) },
        earnings: Array.isArray(stored.earnings) ? stored.earnings : live.earnings,
        yearlyEarnings: Array.isArray(stored.yearlyEarnings) ? stored.yearlyEarnings : live.yearlyEarnings,
        deductions: Array.isArray(stored.deductions) ? stored.deductions : live.deductions,
        paymentMethod: stored.paymentMethod ?? live.paymentMethod,
        paymentDate: stored.paymentDate ?? live.paymentDate,
        currency: stored.currency ?? live.currency,
        slipRef: stored.slipRef || live.slipRef,
        attendanceDeductions: Array.isArray(stored.attendanceDeductions)
            ? stored.attendanceDeductions
            : live.attendanceDeductions,
        loanSchedule: Array.isArray(stored.loanSchedule) ? stored.loanSchedule : live.loanSchedule,
        fines: Array.isArray(stored.fines) ? stored.fines : live.fines,
        utilities: Array.isArray(stored.utilities) ? stored.utilities : live.utilities,
    };
    return recalcSalarySlip(merged);
}

export function applySalarySlipSectionPatch(slip, section, updater) {
    const draft = updater(JSON.parse(JSON.stringify(slip || {})));
    const fromDetails = new Set(['attendanceDeductions', 'loans', 'fines', 'utilities']);
    const synced = fromDetails.has(section) ? pushDetailsIntoDeductions(draft) : draft;
    return recalcSalarySlip(synced);
}

const EXTRA_EARNING = /overtime|leave salary|ticket|reward/i;

function moneyOrZero(value) {
    return money(value);
}

/**
 * Compact row for the enroll Salary slip tab (processed months list).
 */
export function summarizeSalarySlipListRow(slip) {
    const ym = monthKeyOf(slip?.monthKey);
    const match = String(ym || '').match(/^(\d{4})-(\d{2})$/);
    const year = match ? Number(match[1]) : 0;
    const monthName = match ? MONTH_FULL[Number(match[2]) - 1] || match[2] : '';
    const extra = moneyOrZero(
        (slip?.earnings || []).reduce((sum, row) => {
            if (!EXTRA_EARNING.test(String(row?.component || ''))) return sum;
            return sum + moneyOrZero(row?.amount);
        }, 0),
    );
    const gross = moneyOrZero(slip?.grossEarnings);
    return {
        monthKey: ym,
        month: monthName,
        year,
        salary: moneyOrZero(gross - extra),
        extra,
        deduction: moneyOrZero(slip?.totalDeductions),
        totalSalary: moneyOrZero(slip?.netSalary),
        type: /wps/i.test(String(slip?.paymentMethod || '')) ? 'WPS' : 'Cash',
    };
}
