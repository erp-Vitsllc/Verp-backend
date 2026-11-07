import Attendance from '../models/Attendance.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import EmployeeSalary from '../models/EmployeeSalary.js';
import Fine from '../models/Fine.js';
import Holiday from '../models/Holiday.js';
import Loan from '../models/Loan.js';
import PartyExpense from '../models/PartyExpense.js';
import Reward from '../models/Reward.js';
import SalaryEnrollment from '../models/SalaryEnrollment.js';
import SalaryHistoricalProfile from '../models/SalaryHistoricalProfile.js';
import SalarySlipMonth from '../models/SalarySlipMonth.js';
import UtilityBillPayment from '../models/UtilityBillPayment.js';
import { isCompanyShellEmployee } from './attendanceEmployeeFilters.js';
import { resolveEmployeeFinePayableAmount } from './finePayableAmount.js';
import { getScheduledEmailTimeZone, getZonedParts } from './scheduleDailyAtMidnight.js';
import {
    getOffWeekdayKeys,
    getWeekForStaffType,
    holidayAppliesToStaff,
    loadWorkingTimeDoc,
} from './workingTimeHelpers.js';
import { applyLeaveCoverIndex, loadLeaveCoverIndex } from './attendanceLeaveDayCover.js';
import { overlaySuspendedAttendance } from './attendanceSuspension.js';
import { addDays, policyLeaveMultipliers } from './salaryHistoricalCalculations.js';
import { approvedOtRemainder } from './flexibleAttendance.js';
import { compOffAdjustedHours } from './compOffSettlement.js';
import { getVegaLogoDataUrl } from './buildSalarySlipPdfHtml.js';
import { resolveEmployeePayrollPolicy } from './employeeLeavePolicy.js';
import { lateDeductionFromEvents } from './lateDeductionPolicy.js';
import {
    leaveDeductionCountWindow,
    summarizeLeavePageDeductions,
} from './leavePageSalaryDeductions.js';
import { loadLeaveTicketEntitlement } from './loadLeaveTicketEntitlement.js';
import { resolveSalarySlipApprovers } from './resolveSalarySlipApprovers.js';
import { isSalarySlipCycle } from './salarySlipLeaveTicket.js';
import { partialLeavePortion, punchAttendanceKind } from './partialLeaveWindow.js';
import {
    keepAttendanceForProcessingStart,
    resolveSalaryProcessingStartDate,
} from './leaveSalaryVisibility.js';
import { explicitAuthorizedHourShare, isDeductionWaived, isHourLossWaived } from './deductionWaive.js';
import {
    applySalarySlipCountExclusions,
    salarySlipPolicyExclusions,
    shouldHideSalarySlipDeduction,
    shouldHideSalarySlipEarning,
} from './salaryPolicyExclusions.js';
import { getAedCurrencyRates } from './currencyRates.js';
import { payLocationFromEmployee } from './workPayLocation.js';
import {
    loadUtilityPortionContext,
    unpaidEmployeePortionOnSalaryMonth,
} from './utilityEmployeePortionStatus.js';

const MONTH_FULL = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];
const APPROVED_LOAN_STATUSES = ['Approved', 'Pending Payment to Employee', 'Paid'];
const APPROVED_FINE_STATUSES = ['Approved', 'Active', 'Paid', 'Completed'];
const APPROVED_REWARD_STATUSES = ['Approved', 'Approved (Paid)'];
const PRESENT_KEYS = new Set(['on_office', 'work_from_home', 'late_arrived', 'early_go']);

/** A payroll-sheet present day is any day with a time in, a time out, or both. */
export function attendanceDayHasPunch(row) {
    const times = [row?.timeIn, row?.timeOut];
    for (const session of row?.punchSessions || []) {
        times.push(session?.timeIn, session?.timeOut);
    }
    return times.some((value) => String(value || '').trim());
}
const LEAVE_KEYS = new Set(['authorized_leave', 'unauthorized_leave', 'sick_leave', 'on_leave']);
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

function leavePortion(row) {
    const part = String(row?.leaveRequestDayPart || '');
    if (part === 'half' || part === 'quarter') return partialLeavePortion(part);
    if (Number(row?.leaveDayFraction) > 0 && Number(row.leaveDayFraction) < 1) return Number(row.leaveDayFraction);
    return 1;
}

function leaveChargeWeight(row, authorized) {
    const doubled = authorized && Number(row?.leaveDeductionTimes) === 2 ? 2 : 1;
    return leavePortion(row) * doubled;
}

function money(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function formatAed(value) {
    return `AED ${money(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Local paying-currency amount → AED. Rate is units of that currency for 1 AED. */
function amountInAed(amount, perAed) {
    const rate = Number(perAed);
    if (!(rate > 0) || rate === 1) return money(amount);
    return money(money(amount) / rate);
}

function convertSalaryEntryToAed(entry, perAed) {
    if (!entry) return entry;
    const scale = (value) => amountInAed(value, perAed);
    const extras = Array.isArray(entry.additionalAllowances)
        ? entry.additionalAllowances.map((row) => ({ ...row, amount: scale(row?.amount) }))
        : entry.additionalAllowances;
    return {
        ...entry,
        basic: scale(entry.basic),
        houseRentAllowance: scale(entry.houseRentAllowance),
        otherAllowance: scale(entry.otherAllowance),
        vehicleAllowance: scale(entry.vehicleAllowance),
        fuelAllowance: scale(entry.fuelAllowance),
        totalSalary: scale(entry.totalSalary),
        monthlySalary: scale(entry.monthlySalary),
        additionalAllowances: extras,
    };
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

function cycleBelongsToSlipMonth(cycle, ym) {
    if (isSalarySlipCycle(cycle)) {
        const inThisMonth = isSalarySlipCycle(cycle, ym);
        return { leave: inThisMonth, ticket: inThisMonth };
    }
    return {
        leave: cycleInMonth(cycle?.leaveSalaryPaymentDate || cycle?.paymentDate, ym),
        ticket: cycleInMonth(cycle?.ticketPaymentDate || cycle?.paymentDate, ym),
    };
}

function addMonthsYm(ym, count) {
    const match = String(ym || '').match(/^(\d{4})-(\d{2})$/);
    if (!match) return '';
    const date = new Date(Number(match[1]), Number(match[2]) - 1 + count, 1);
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

function isEmployeeUnpaidStatus(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return true;
    if (raw === 'paid' || raw === 'completed') return false;
    return true;
}

function compareYm(left, right) {
    const a = payableMonthKey(left);
    const b = payableMonthKey(right);
    if (!a || !b) return 0;
    if (a === b) return 0;
    return a < b ? -1 : 1;
}

/** Unpaid party parts due on or before this salary month (prior unpaid months carry forward). */
export function unpaidDueByMonth(exp, ym) {
    if (!exp || !isEmployeeUnpaidStatus(exp.status)) return 0;
    const target = payableMonthKey(ym);
    if (!target) return 0;
    const parts = Array.isArray(exp.installments) ? exp.installments : [];
    if (parts.length) {
        return money(parts.reduce((sum, row) => {
            const key = payableMonthKey(row.monthKey);
            if (!key || compareYm(key, target) > 0) return sum;
            if (!isEmployeeUnpaidStatus(row.status)) return sum;
            return money(sum + money(row.amount));
        }, 0));
    }
    const expMonth = payableMonthKey(exp.billMonth || exp.monthStart);
    if (!expMonth || compareYm(expMonth, target) > 0) return 0;
    return money(exp.amount);
}

function unpaidInstallmentForMonth(exp, ym) {
    return unpaidDueByMonth(exp, ym);
}

/** Unpaid scheduled installments from start through this month, including overdue prior months. */
export function unpaidSchedulePortion({ total, repaid, startYm, duration, ym }) {
    const start = payableMonthKey(startYm);
    const target = payableMonthKey(ym);
    const months = Math.max(1, Number(duration) || 1);
    const due = money(total);
    if (!start || !target || due <= 0) return 0;
    if (compareYm(target, start) < 0) return 0;
    let paidLeft = Math.max(0, money(repaid));
    const base = money(due / months);
    let allocated = 0;
    let dueByMonth = 0;
    for (let i = 0; i < months; i += 1) {
        const key = addMonthsYm(start, i);
        const portion = i === months - 1 ? money(due - allocated) : base;
        allocated = money(allocated + portion);
        const paidHere = Math.min(paidLeft, portion);
        paidLeft = money(paidLeft - paidHere);
        const unpaid = money(portion - paidHere);
        if (compareYm(key, target) <= 0) {
            dueByMonth = money(dueByMonth + unpaid);
        }
    }
    return dueByMonth;
}

/**
 * Not Paid amount for this salary month and every earlier installment.
 * A later month (November on an October slip) stays off the total.
 * Installment rows are used when they exist. Otherwise the loan or fine
 * schedule is split by month, so September plus October is not the whole balance.
 */
export function dueThroughSalaryMonth(party, schedule) {
    if (party && !isEmployeeUnpaidStatus(party.status)) return 0;
    const parts = Array.isArray(party?.installments) ? party.installments : [];
    const datedParts = parts.filter((row) => payableMonthKey(row?.monthKey));
    if (datedParts.length) {
        const fromParts = unpaidDueByMonth({ ...party, installments: datedParts }, schedule.ym);
        if (fromParts > 0) return fromParts;
        const hasDueOrPastPart = datedParts.some((row) => compareYm(row.monthKey, schedule.ym) <= 0);
        if (hasDueOrPastPart) return 0;
    }
    return unpaidSchedulePortion(schedule);
}

function installmentPaidTotal(parts) {
    return money((parts || []).reduce((sum, row) => {
        if (isEmployeeUnpaidStatus(row?.status)) return sum;
        return money(sum + money(row?.amount));
    }, 0));
}

/**
 * Not Paid loan or advance due on this slip.
 * Company disbursement marks the party expense Paid. That is not employee repayment.
 * Installment Paid flags count only when their total matches repaidAmount.
 */
export function recoveryDueThroughSalaryMonth({ total, repaid, startYm, duration, ym, party } = {}) {
    const due = money(total);
    const recovered = Math.max(0, money(repaid));
    const remaining = Math.max(0, money(due - recovered));
    if (remaining <= 0.009 || due <= 0) return 0;
    const schedule = { total: due, repaid: recovered, startYm, duration, ym };
    const datedParts = (Array.isArray(party?.installments) ? party.installments : [])
        .filter((row) => payableMonthKey(row?.monthKey));
    const paidOnParts = installmentPaidTotal(datedParts);
    const partsMatchRecovery = datedParts.length > 0 && Math.abs(paidOnParts - recovered) <= 0.05;
    if (!partsMatchRecovery) return Math.min(remaining, unpaidSchedulePortion(schedule));
    const openParty = party && !isEmployeeUnpaidStatus(party.status)
        ? { ...party, status: 'Not Paid' }
        : party;
    return Math.min(remaining, dueThroughSalaryMonth(openParty, schedule));
}

function unpaidThisMonthFromPartyOrSchedule(party, schedule) {
    return dueThroughSalaryMonth(party, schedule);
}

function partyExpenseFor(expenses, { kind, mongoField, mongoId } = {}) {
    const wantId = mongoId ? String(mongoId) : '';
    return (expenses || []).find((exp) => {
        if (kind && exp.kind !== kind) return false;
        if (wantId && String(exp[mongoField] || '') !== wantId) return false;
        return true;
    }) || null;
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
        dueAmount: 0,
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
            .select('employeeId firstName lastName designation staffType status overtime company dateOfJoining noticeRequest.exitDate workLocation workingFromCountry workingFromCountryCode salaryCurrency workTimeZone attendanceAccountStatus attendanceSuspension')
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
                .select(
                    'salarySlip companyMolCode paymentCycles annualLeaveRecords leaveRecords verpStartDate contractJoiningDate hiddenSystemLeave',
                )
                .lean(),
            resolveEmployeePayrollPolicy(emp),
            loadWorkingTimeDoc(),
            Attendance.find({
                $or: [{ employeeMongoId: mongoId }, { employeeId: idPattern }],
                date: { $gte: from, $lte: to },
            })
                .select('date statusKey statusLabel reason leavePayType timeIn timeOut timeOutDate punchSessions flexibleWorkedHours flexibleRequiredHours hourAdjustStatus hourAdjustMode hourAdjustKind hoursApproved hoursTaken deductionWaived flexibleOtStatus flexibleOtApprovedHours flexibleOtNextDayDate leaveRequestStatus requestedStatusKey leaveRequestKind leaveRequestDayPart leaveDayFraction leaveDeductionTimes leaveRequestSession leaveCoverBlocked employeeMongoId')
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
                status: { $in: ['Approved', 'Paid'] },
                $or: [
                    { payByEmployeeId: idPattern },
                    { payByEmployeeId: mongoId },
                    { 'zohoLineItems.payByEmployeeId': idPattern },
                    { 'zohoLineItems.payByEmployeeId': mongoId },
                ],
            })
                .select(
                    'utilityType billMonth employeePayAmount payByEmployeeId paymentBy notes status zohoLineItems.payByEmployeeId zohoLineItems.amount billNumber accountNo',
                )
                .lean(),
            PartyExpense.find({
                partyType: 'employee',
                employeeId: idPattern,
                kind: { $in: ['loan', 'advance', 'fine', 'balance'] },
            })
                .select('kind amount duration monthStart billMonth status installments loanMongoId fineMongoId utilityBillId utilityType')
                .lean(),
        ]);

    const leaveTicketState = await loadLeaveTicketEntitlement({
        employee: emp,
        profile,
        salaryDoc,
        policy,
    }).catch((error) => {
        console.error('[buildSalarySlipPayload] leave ticket', error?.message || error);
        return null;
    });

    const pay = payLocationFromEmployee({
        workLocation: emp.workLocation || salaryDoc?.workLocation,
        workingFromCountry: emp.workingFromCountry || salaryDoc?.workingFromCountry,
        workingFromCountryCode: emp.workingFromCountryCode || salaryDoc?.workingFromCountryCode,
        salaryCurrency: emp.salaryCurrency || salaryDoc?.salaryCurrency,
        workTimeZone: emp.workTimeZone || salaryDoc?.workTimeZone,
    });
    let perAed = 1;
    if (pay.workLocation === 'outside_uae' && pay.salaryCurrency && pay.salaryCurrency !== 'AED') {
        const quote = await getAedCurrencyRates();
        const rate = Number(quote?.rates?.[pay.salaryCurrency]);
        if (rate > 0) perAed = rate;
    }
    const toAed = (amount) => amountInAed(amount, perAed);
    let entry = resolvedSalaryEntry(salaryDoc, ym);
    if (perAed !== 1) entry = convertSalaryEntryToAed(entry, perAed);
    const monthly = monthlySalaryOf(entry);
    const daily = monthly > 0 && daysInMonth > 0 ? money(monthly / daysInMonth) : 0;
    const leaveMultipliers = policyLeaveMultipliers(policy);
    const authTimes = leaveMultipliers.authorized;
    const unauthTimes = leaveMultipliers.unauthorized;
    const latePolicy = lateDeductionFromEvents(0, policy);
    const lateTimes = latePolicy.multiplier;
    const week = getWeekForStaffType(workingTime, emp.staffType);
    const holidaySet = new Set(
        (holidayDocs || [])
            .filter((row) => holidayAppliesToStaff(row, emp.staffType))
            .map((row) => dateKeyOf(row.date))
            .filter((date) => isDateInSalaryMonth(date, ym)),
    );
    let coveredAttendance = attendance || [];
    try {
        const coverIndex = await loadLeaveCoverIndex({ from, to, employees: [emp] });
        coveredAttendance = applyLeaveCoverIndex(coveredAttendance, coverIndex);
    } catch (error) {
        console.error('[buildSalarySlipPayload] leave cover', error?.message || error);
    }
    // A suspended day is not worked and not leave. The Leave page uses the same overlay.
    coveredAttendance = overlaySuspendedAttendance(coveredAttendance, emp, from, to);

    const coveredOtSources = new Set(
        coveredAttendance
            .map((row) => String(row?.flexibleFromOtDate || '').trim())
            .filter(Boolean),
    );
    let presentDays = 0;
    let punchedPresentDays = 0;
    let workingDayLeaves = 0;
    let authorizedDays = 0;
    let explicitAuthorizedShares = 0;
    let unauthorizedDays = 0;
    let sickDays = 0;
    let unpaidSickDays = 0;
    let annualDays = 0;
    let lateEvents = 0;
    let missedPunchDays = 0;
    let holidayMarks = 0;
    let holidaysWorked = 0;
    let compOffDays = 0;
    let otHours = 0;
    let otDays = 0;
    const countedDates = new Set();
    const countedAttendance = [];

    const enrollment = await SalaryEnrollment.findOne({ employeeId: idPattern })
        .select('fromMonth salaryDate processDate')
        .lean();
    const processingStart = resolveSalaryProcessingStartDate({
        verpStartDate: profile?.verpStartDate,
        enrollment,
    });
    for (const row of coveredAttendance) {
        const date = dateKeyOf(row.date);
        if (!isDateInSalaryMonth(date, ym) || countedDates.has(date)) continue;
        if (!keepAttendanceForProcessingStart(row, processingStart)) continue;
        countedDates.add(date);
        countedAttendance.push(row);
        if (attendanceDayHasPunch(row)) punchedPresentDays += 1;
        const storedKey = String(row.statusKey || '');
        const key = punchAttendanceKind(row) || storedKey;
        if (key === 'holiday') holidayMarks += 1;
        if (key === 'compoff_leave') compOffDays += 1;
        if (PRESENT_KEYS.has(key)) presentDays += 1;
        if (LEAVE_KEYS.has(key)) workingDayLeaves += 1;
        const waived = isDeductionWaived(row) || isHourLossWaived(row);
        if (!waived && key === 'authorized_leave') {
            const share = explicitAuthorizedHourShare(row);
            if (share != null) explicitAuthorizedShares += share * leavePortion(row);
            else authorizedDays += leaveChargeWeight(row, true);
        }
        if (!waived && key === 'unauthorized_leave') unauthorizedDays += leaveChargeWeight(row, false);
        if (key === 'sick_leave') {
            sickDays += 1;
        }
        if (key === 'on_leave') annualDays += 1;
        if (!waived && key === 'mispunch') missedPunchDays += 1;

        const isHolidayDate = holidaySet.has(date) || key === 'holiday';
        const punched = Boolean(row.timeIn && row.timeOut);
        if (isHolidayDate && punched) holidaysWorked += 1;

        const nextDayOt = String(row.flexibleOtNextDayDate || '').trim();
        const otHoursApproved =
            String(row.flexibleOtStatus || '') === 'approved' &&
            !nextDayOt &&
            !coveredOtSources.has(date)
                ? approvedOtRemainder(row.flexibleOtApprovedHours)
                : 0;
        const ot = { hours: otHoursApproved, isOffDay: false };
        if (ot.hours <= 0) continue;
        if (ot.isOffDay || isHolidayDate) {
            otDays += 1;
        } else {
            otHours += ot.hours;
        }
    }

    const exclusions = salarySlipPolicyExclusions(code, policy);
    ({
        workingDayLeaves,
        authorizedDays,
        unauthorizedDays,
        sickDays,
        unpaidSickDays,
        annualDays,
        compOffDays,
        lateEvents,
        missedPunchDays,
        holidaysWorked,
        otHours,
        otDays,
    } = applySalarySlipCountExclusions(
        {
            workingDayLeaves,
            authorizedDays,
            unauthorizedDays,
            sickDays,
            unpaidSickDays,
            annualDays,
            compOffDays,
            lateEvents,
            missedPunchDays,
            holidaysWorked,
            otHours,
            otDays,
        },
        exclusions,
    ));

    const compOffOtDeducted = await compOffAdjustedHours(mongoId, ym);
    if (compOffOtDeducted > 0) {
        otHours = Math.max(0, Math.round((otHours - compOffOtDeducted) * 100) / 100);
    }

    const holidays = Math.max(holidaySet.size, holidayMarks);
    const otHoursAmount = money((daily / 10) * otHours);
    const otDaysAmount = money(daily * otDays);
    const countWindow = leaveDeductionCountWindow({
        monthKey: ym,
        joinKey: dateKeyOf(profile?.contractJoiningDate) || dateKeyOf(emp.dateOfJoining),
        processingStart,
        todayKey: (() => {
            const dubai = getZonedParts(new Date(), getScheduledEmailTimeZone());
            return `${dubai.year}-${pad2(dubai.month)}-${pad2(dubai.day)}`;
        })(),
    });
    const pageDeductions = summarizeLeavePageDeductions({
        records: coveredAttendance,
        policy,
        week,
        daily,
        holidayDates: holidaySet,
        offWeekdays: new Set(getOffWeekdayKeys(week)),
        from: countWindow.from,
        to: countWindow.to,
        authTimes,
        unauthTimes,
    });
    if (exclusions.leave || exclusions.attendance) {
        pageDeductions.authorized = { days: 0, amount: 0 };
        pageDeductions.unauthorized = { days: 0, amount: 0 };
        pageDeductions.annual = { days: 0, amount: 0 };
        pageDeductions.sandwich = { days: 0, amount: 0 };
    }
    if (exclusions.attendance) {
        pageDeductions.lateIn = { count: 0, amount: 0 };
        pageDeductions.lateOut = { count: 0, amount: 0 };
        pageDeductions.missed = { count: 0, amount: 0 };
    }
    authorizedDays = pageDeductions.authorized.days;
    explicitAuthorizedShares = 0;
    unauthorizedDays = pageDeductions.unauthorized.days;
    annualDays = pageDeductions.annual.days;
    missedPunchDays = pageDeductions.missed.count;
    const sandwichDays = pageDeductions.sandwich.days;
    const authorizedDeductionDays = authorizedDays;
    const authorizedAmount = pageDeductions.authorized.amount;
    const unauthorizedAmount = pageDeductions.unauthorized.amount;
    const sickAmount = money(daily * unpaidSickDays);
    const annualAmount = pageDeductions.annual.amount;
    const sandwichAmount = pageDeductions.sandwich.amount;
    const lateInAmount = pageDeductions.lateIn.amount;
    const lateOutAmount = pageDeductions.lateOut.amount;
    const missedAmount = pageDeductions.missed.amount;
    const lateInCount = pageDeductions.lateIn.count;
    const lateOutCount = pageDeductions.lateOut.count;

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
        const inMonth = cycleBelongsToSlipMonth(cycle, ym);
        if (inMonth.leave) {
            const cycleLeave = toAed(cycle.leaveSalaryAmount || cycle.leaveSalary);
            leaveSalaryAmount = money(leaveSalaryAmount + cycleLeave);
            if (daily > 0 && cycleLeave > 0) {
                leaveSalaryDays += Math.round(cycleLeave / daily);
            }
        }
        if (inMonth.ticket) {
            ticketAmount = money(ticketAmount + money(cycle.ticketAmount));
        }
    }
    const leaveFromCycles = leaveSalaryAmount;
    const ticketFromCycles = ticketAmount;
    const leaveRemaining = toAed(leaveTicketState?.leaveRemaining);
    const ticketRemaining = money(leaveTicketState?.ticketRemaining);
    const leaveDue = toAed(leaveTicketState?.leaveDue || leaveTicketState?.entitlements?.totalLeaveSalary);
    const ticketDue = money(leaveTicketState?.ticketDue || leaveTicketState?.entitlements?.totalTicketAmount);
    const leavePayMax = money(leaveRemaining + leaveFromCycles) || leaveDue;
    const ticketPayMax = money(ticketRemaining + ticketFromCycles) || ticketDue;
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
    let yearlyLeaveSalaryAmount = toAed(sumBenefitInYear(profile?.paymentCycles, slipYear, {
        amountKeys: ['leaveSalaryAmount', 'leaveSalary'],
        dateKeys: leaveSalaryDateKeys,
    }));
    if (yearlyLeaveSalaryAmount <= 0) {
        yearlyLeaveSalaryAmount = toAed(
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
        { component: 'Leave Salary', basis: 'Yearly', amount: leaveSalaryAmount },
        { component: 'Travel Allowance', basis: 'Yearly', amount: ticketAmount },
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
        const remaining = Math.max(0, money(total - repaid));
        const dueAmount = recoveryDueThroughSalaryMonth({
            total,
            repaid,
            startYm: start,
            duration,
            ym,
            party,
        });
        const thisMonthAmount = dueAmount;
        const type = isAdvance ? 'Salary Advance' : 'Loan';
        countedLoanIds.add(String(loan._id || ''));
        if (thisMonthAmount > 0) {
            if (type === 'Salary Advance') advanceMonth = money(advanceMonth + thisMonthAmount);
            else loanMonth = money(loanMonth + thisMonthAmount);
        }
        loanSchedule.push({
            sourceId: String(loan._id || ''),
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
            dueAmount,
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
        const remaining = Math.max(0, money(payable - paid));
        const dueAmount = Math.min(
            remaining,
            dueThroughSalaryMonth(party, {
                total: payable,
                repaid: paid,
                startYm: startFineYm,
                duration,
                ym,
            }),
        );
        const thisMonthAmount = dueAmount;
        const installment = money(payable / duration);
        countedFineIds.add(String(fine._id || ''));
        if (thisMonthAmount > 0) fineMonth = money(fineMonth + thisMonthAmount);
        const typeLabel = String(fine.fineType || fine.subCategory || fine.category || 'Fine').trim() || 'Fine';
        fineRows.push({
            sourceId: String(fine._id || ''),
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
            dueAmount,
            approved: true,
        });
    }

    let utilityMonth = 0;
    const utilities = [];
    const utilityContext = (utilityBills || []).length
        ? await loadUtilityPortionContext([code, mongoId], utilityBills)
        : null;
    for (const exp of partyExpenses || []) {
        if (exp.kind === 'balance') continue;
        const total = money(exp.amount);
        const paid = paidFromPartyExpense(exp);
        const remaining = Math.max(0, money(total - paid));
        const dueAmount = Math.min(
            remaining,
            dueThroughSalaryMonth(exp, {
                total,
                repaid: paid,
                startYm: exp.monthStart || exp.billMonth,
                duration: exp.duration,
                ym,
            }),
        );
        const thisMonthAmount = dueAmount;
        if (total <= 0 && thisMonthAmount <= 0) continue;
        if (exp.kind === 'fine') {
            if (countedFineIds.has(String(exp.fineMongoId || ''))) continue;
            countedFineIds.add(String(exp.fineMongoId || ''));
            if (thisMonthAmount > 0) fineMonth = money(fineMonth + thisMonthAmount);
            fineRows.push({
                sourceId: String(exp.fineMongoId || exp._id || ''),
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
                dueAmount,
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
                sourceId: String(exp.loanMongoId || exp._id || ''),
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
                dueAmount,
                approved: true,
            });
        }
    }

    if (!loanSchedule.some((row) => row.type === 'Salary Advance')) loanSchedule.unshift(emptyLoanRow('Salary Advance'));
    if (!loanSchedule.some((row) => row.type === 'Loan')) loanSchedule.push(emptyLoanRow('Loan'));

    for (const bill of utilityBills || []) {
        const billId = String(bill._id || '');
        if (billId && countedUtilityIds.has(billId)) continue;
        if (billId) countedUtilityIds.add(billId);
        const outstanding = unpaidEmployeePortionOnSalaryMonth({
            bill,
            employeeIds: utilityContext?.employeeIds || [code, mongoId],
            payments: utilityContext?.payments || [],
            partyExpense: utilityContext?.expenseByBill.get(billId) || null,
            payrollZohoMonths: utilityContext?.payrollZohoMonths || [],
            zohoExpenseMatched: Boolean(utilityContext?.zohoMatched.has(billId)),
            salaryMonth: ym,
        });
        if (outstanding <= 0.009) continue;
        utilityMonth = money(utilityMonth + outstanding);
        utilities.push({
            sourceId: billId,
            details: String(bill.utilityType || 'Utility').trim() || 'Utility',
            amount: formatAed(outstanding),
            reason: String(bill.notes || 'Unpaid employee portion').trim(),
            total: outstanding,
            paid: 0,
            thisMonthAmount: outstanding,
            thisMonth: formatAed(outstanding),
            dueAmount: outstanding,
            remainingAmount: outstanding,
            originalAmount: outstanding,
            paidAmount: 0,
            approved: true,
        });
    }

    const deductions = [
        { component: 'Late in', basis: qtyLabel(lateInCount, 'event'), amount: lateInAmount },
        { component: 'Late out', basis: qtyLabel(lateOutCount, 'event'), amount: lateOutAmount },
        { component: 'Missed Punch', basis: qtyLabel(missedPunchDays, 'event'), amount: missedAmount },
        { component: 'Authorized Leave', basis: qtyLabel(authorizedDeductionDays, 'day'), amount: authorizedAmount },
        { component: 'Unauthorized Leave', basis: qtyLabel(unauthorizedDays, 'day'), amount: unauthorizedAmount },
        { component: 'Sandwich Leave', basis: qtyLabel(sandwichDays, 'day'), amount: sandwichAmount },
        { component: 'Annual Leave', basis: qtyLabel(annualDays, 'day'), amount: annualAmount },
        { component: 'Sick Leave', basis: qtyLabel(sickDays, 'day'), amount: sickAmount },
        { component: 'Salary Advance', basis: 'Schedule', amount: advanceMonth },
        { component: 'Loan', basis: 'Monthly', amount: loanMonth },
        { component: 'Fine', basis: 'Installment', amount: fineMonth },
        { component: 'Utility Excess', basis: utilities[0]?.details || 'Mobile', amount: utilityMonth },
    ];

    const grossEarnings = money(earnings.reduce((sum, row) => sum + money(row.amount), 0));
    const totalDeductions = money(deductions.reduce((sum, row) => sum + money(row.amount), 0));
    const netSalary = money(Math.max(0, grossEarnings - totalDeductions));
    const attendanceDeductionTotal = money(
        authorizedAmount + unauthorizedAmount + sickAmount + annualAmount + sandwichAmount + lateInAmount + lateOutAmount + missedAmount,
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
            calculation: annualDays > 0
                ? `${qtyLabel(annualDays, 'day')} x 1 x ${formatAed(daily)}`
                : 'No deduction for this month',
            total: annualAmount,
        },
        {
            category: 'Sandwich Leave',
            qty: qtyLabel(sandwichDays, 'day'),
            rate: formatAed(sandwichDays > 0 ? daily : 0),
            calculation: sandwichDays > 0
                ? `${qtyLabel(sandwichDays, 'day')} x 1 x ${formatAed(daily)}`
                : 'No deduction for this month',
            total: sandwichAmount,
        },
        {
            category: 'Late in',
            qty: qtyLabel(lateInCount, 'event'),
            rate: formatAed(daily),
            calculation: lateInAmount > 0
                ? `${qtyLabel(lateInCount, 'event')} x ${formatAed(lateInAmount / Math.max(lateInCount, 1))}`
                : 'No deduction for this month',
            total: lateInAmount,
        },
        {
            category: 'Late out',
            qty: qtyLabel(lateOutCount, 'event'),
            rate: formatAed(daily),
            calculation: lateOutAmount > 0
                ? `${qtyLabel(lateOutCount, 'event')} x ${formatAed(lateOutAmount / Math.max(lateOutCount, 1))}`
                : 'No deduction for this month',
            total: lateOutAmount,
        },
        {
            category: 'Missed Punch',
            qty: qtyLabel(missedPunchDays, 'event'),
            rate: formatAed(missedPunchDays > 0 ? money(missedAmount / missedPunchDays) : 0),
            calculation: missedAmount > 0
                ? `${qtyLabel(missedPunchDays, 'event')} x ${formatAed(daily)}`
                : 'No deduction for this month',
            total: missedAmount,
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
        exclusions,
        attendance: {
            holidays: qtyLabel(holidays, 'day'),
            workingDayLeaves: qtyLabel(workingDayLeaves, 'day'),
            presentDays: qtyLabel(presentDays, 'day'),
            punchedPresentDays,
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
            leaveSalary: {
                ...benefitFromCycles(
                    profile?.paymentCycles,
                    ['leaveSalaryAmount', 'leaveSalary'],
                    ym,
                    ['leaveSalaryPaymentDate', 'paymentDate'],
                ),
                amount: leaveSalaryAmount,
                remaining: leaveRemaining,
                max: leavePayMax,
                due: leaveDue,
            },
            airTicket: {
                ...benefitFromCycles(
                    profile?.paymentCycles,
                    ['ticketAmount'],
                    ym,
                    ['ticketPaymentDate', 'paymentDate'],
                ),
                amount: ticketAmount,
                remaining: ticketRemaining,
                max: ticketPayMax,
                due: ticketDue,
            },
            leaveMultipliers: {
                authorized: authTimes,
                unauthorized: unauthTimes,
                annual: 1,
                late: lateTimes,
            },
            lossOfPayDays: {
                authorized: authorizedDeductionDays,
                unauthorized: unauthorizedDays,
                late: lateInCount,
                earlyOut: lateOutCount,
                annual: annualDays,
                sandwich: sandwichDays,
                compOff: compOffDays,
            },
            otherDeductionTimes: {
                loan: installmentTimes(
                    loanSchedule.filter((row) => !/advance/i.test(String(row.type || ''))),
                    (row) => row.thisMonthAmount,
                ),
                fine: installmentTimes(fineRows, (row) => row.thisMonthAmount),
                utilityExcess: installmentTimes(utilities, (row) => row.thisMonthAmount),
                salaryAdvance: installmentTimes(
                    loanSchedule.filter((row) => /advance/i.test(String(row.type || ''))),
                    (row) => row.thisMonthAmount,
                ),
            },
        },
        fileName: `Salary-Slip-${ym}-${code}.pdf`,
    };

    payload.approvers = await resolveSalarySlipApprovers({ monthKey: ym, employeeId: code });

    if (!skipOverride) {
        try {
            const stored = await SalarySlipMonth.findOne({ employeeId: code, monthKey: ym })
                .select('slip')
                .lean();
            if (stored?.slip) {
                const merged = mergeStoredSalarySlip(payload, stored.slip);
                merged.approvers = payload.approvers;
                return presentSalarySlipPolicyExclusions({ ...merged, exclusions });
            }
        } catch (error) {
            console.error('[buildSalarySlipPayload] override', error?.message || error);
        }
    }
    return presentSalarySlipPolicyExclusions(payload);
}

function presentSalarySlipPolicyExclusions(slip) {
    const exclusions = slip?.exclusions || {};
    if (!exclusions.leave && !exclusions.attendance) return slip;
    const hideLeaveStats = Boolean(exclusions.leave || exclusions.attendance);
    const next = {
        ...slip,
        exclusions,
        attendance: {
            ...(slip.attendance || {}),
            ...(hideLeaveStats ? { workingDayLeaves: '—', compOffLeave: '—' } : {}),
            ...(exclusions.attendance
                ? { overtimeHours: hoursLabel(0), holidaysWorked: qtyLabel(0, 'day') }
                : {}),
        },
        earnings: (slip.earnings || []).filter(
            (row) => !shouldHideSalarySlipEarning(row.component, exclusions),
        ),
        deductions: (slip.deductions || []).filter(
            (row) => !shouldHideSalarySlipDeduction(row.component, exclusions),
        ),
        attendanceDeductions: (slip.attendanceDeductions || []).filter(
            (row) => !shouldHideSalarySlipDeduction(row.category, exclusions),
        ),
        summary: {
            ...(slip.summary || {}),
            overtimeHoursCount: exclusions.attendance ? 0 : slip.summary?.overtimeHoursCount,
            overtimeDaysCount: exclusions.attendance ? 0 : slip.summary?.overtimeDaysCount,
            lossOfPayDays: {
                ...(slip.summary?.lossOfPayDays || {}),
                ...(hideLeaveStats
                    ? { authorized: 0, unauthorized: 0, annual: 0, sandwich: 0, compOff: 0 }
                    : {}),
                ...(exclusions.attendance ? { late: 0, earlyOut: 0 } : {}),
            },
        },
    };
    return recalcSalarySlip(next);
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

function benefitOverrideKey(nameKey) {
    if (nameKey === 'leave salary') return 'leaveSalary';
    if (nameKey === 'ticket' || nameKey === 'travel allowance') return 'ticket';
    return '';
}

function storedAmountKept(storedRow, overrides) {
    if (!storedRow || !overrides) return false;
    const component = String(storedRow.component || storedRow.category || storedRow.type || '').trim();
    const key = rowNameKey(storedRow);
    const benefit = benefitOverrideKey(key);
    if (benefit && overrides[benefit]) return true;
    if (component && overrides[component]) return true;
    if (key && overrides[key]) return true;
    return false;
}

function mergeAmountRows(stored, live, { overrides = {}, caps = {} } = {}) {
    const liveRows = Array.isArray(live) ? live : [];
    const storedRows = Array.isArray(stored) ? stored : [];
    const storedByKey = new Map(storedRows.map((row) => [rowNameKey(row), row]));
    const used = new Set();
    const merged = liveRows.map((liveRow) => {
        const key = rowNameKey(liveRow);
        used.add(key);
        const storedRow = storedByKey.get(key);
        if (!storedRow) return liveRow;
        const overrideKey = benefitOverrideKey(key);
        let amount = storedAmountKept(storedRow, overrides)
            ? money(storedRow.amount)
            : money(liveRow.amount);
        if (overrideKey && overrides[overrideKey]) {
            amount = money(storedRow.amount);
        }
        if (overrideKey === 'leaveSalary' && money(caps.leave) > 0) {
            amount = Math.max(0, Math.min(amount, money(caps.leave)));
        }
        if (overrideKey === 'ticket' && money(caps.ticket) > 0) {
            amount = Math.max(0, Math.min(amount, money(caps.ticket)));
        }
        return {
            ...storedRow,
            ...liveRow,
            basis: liveRow.basis || storedRow.basis,
            amount,
        };
    });
    for (const row of storedRows) {
        if (!used.has(rowNameKey(row))) merged.push(row);
    }
    return merged;
}

function mergeStoredThisMonth(liveRows, storedRows, applyRow) {
    if (!Array.isArray(liveRows)) return liveRows;
    const stored = Array.isArray(storedRows) ? storedRows : [];
    const byId = new Map();
    stored.forEach((row) => {
        const id = String(row?.sourceId || '');
        if (id) byId.set(id, row);
    });
    return liveRows.map((live, index) => {
        if (typeof applyRow === 'function' && !applyRow(live)) return live;
        const storedRow = (live.sourceId && byId.get(String(live.sourceId))) || stored[index];
        if (!storedRow) return live;
        if (storedRow.thisMonthAmount == null && storedRow.thisMonth == null) return live;
        const total = money(live?.dueAmount ?? live?.remainingAmount ?? live?.originalAmount ?? live?.total ?? live?.amount);
        const next = money(storedRow.thisMonthAmount ?? storedRow.thisMonth);
        const capped = Math.max(0, total > 0 ? Math.min(next, total) : 0);
        return { ...live, thisMonthAmount: capped, thisMonth: formatAed(capped) };
    });
}

function preferLiveComputed(merged, live) {
    if (!merged) return live;
    if (!live) return merged;
    const overrides = merged.thisMonthOverrides || {};
    const benefitCaps = {
        leave: live?.summary?.leaveSalary?.max,
        ticket: live?.summary?.airTicket?.max,
    };
    const loanSchedule = mergeStoredThisMonth(
        live.loanSchedule,
        merged.loanSchedule,
        (row) => (/advance/i.test(String(row?.type || '')) ? overrides['Salary Advance'] : overrides.Loan),
    );
    const fines = mergeStoredThisMonth(
        live.fines,
        merged.fines,
        () => Boolean(overrides.Fine),
    );
    const utilities = mergeStoredThisMonth(
        live.utilities,
        merged.utilities,
        () => Boolean(overrides.Utility),
    );
    const earnings = mergeAmountRows(merged.earnings, live.earnings, { overrides, caps: benefitCaps });
    const yearlyEarnings = mergeAmountRows(merged.yearlyEarnings, live.yearlyEarnings, {
        overrides,
        caps: benefitCaps,
    });
    const next = recalcSalarySlip(pushDetailsIntoDeductions({
        ...merged,
        earnings,
        yearlyEarnings,
        deductions: mergeAmountRows(merged.deductions, live.deductions, { overrides }),
        attendance: { ...(merged.attendance || {}), ...(live.attendance || {}) },
        loanSchedule,
        fines,
        utilities,
        attendanceDeductions: Array.isArray(live.attendanceDeductions)
            ? live.attendanceDeductions
            : merged.attendanceDeductions,
        summary: live.summary || merged.summary,
        thisMonthOverrides: overrides,
    }));
    const leaveAmount = money(
        (yearlyEarnings.find((row) => rowNameKey(row) === 'leave salary') ||
            earnings.find((row) => rowNameKey(row) === 'leave salary'))?.amount,
    );
    const ticketAmount = money(
        (yearlyEarnings.find((row) => rowNameKey(row) === 'travel allowance') ||
            yearlyEarnings.find((row) => rowNameKey(row) === 'ticket') ||
            earnings.find((row) => rowNameKey(row) === 'ticket'))?.amount,
    );
    next.summary = {
        ...(next.summary || {}),
        leaveSalary: {
            ...(live.summary?.leaveSalary || {}),
            amount: leaveAmount,
            remaining: money(live.summary?.leaveSalary?.remaining),
            max: money(live.summary?.leaveSalary?.max),
            due: money(live.summary?.leaveSalary?.due),
        },
        airTicket: {
            ...(live.summary?.airTicket || {}),
            amount: ticketAmount,
            remaining: money(live.summary?.airTicket?.remaining),
            max: money(live.summary?.airTicket?.max),
            due: money(live.summary?.airTicket?.due),
        },
    };
    return next;
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

function deductionLineOverridden(overrides, name) {
    if (!overrides || !name) return false;
    if (overrides[name]) return true;
    const key = deductionKey(name);
    if (key && overrides[key]) return true;
    return Object.keys(overrides).some((flag) => {
        if (!overrides[flag]) return false;
        return flag === name || deductionMatches(name, flag) || deductionMatches(flag, name);
    });
}

function pushDetailsIntoDeductions(slip) {
    let deductions = Array.isArray(slip.deductions) ? slip.deductions.map((row) => ({ ...row })) : [];
    const overrides = slip?.thisMonthOverrides || {};
    for (const row of slip.attendanceDeductions || []) {
        if (deductionLineOverridden(overrides, row.category)) continue;
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
    const utilTotal = (slip.utilities || []).reduce(
        (sum, row) => sum + money(row.thisMonthAmount ?? row.thisMonth),
        0,
    );
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
    const utilityExcess = money(
        utilities.reduce((sum, row) => sum + money(row.thisMonthAmount ?? row.thisMonth), 0),
    );
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

/**
 * Keep a saved salary-slip edit (including a cleared amount) and refresh
 * every other line from the live month.
 */
export function mergeStoredSalarySlip(live, stored) {
    if (!live) return stored || null;
    if (!stored) return live;
    return preferLiveComputed(applySalarySlipOverride(live, stored), live);
}

const ADDITION_EARNING = /overtime|leave salary|ticket|reward/i;

function payrollFigureKey(value) {
    return String(value || '').trim().replace(/\s+/g, '').toUpperCase();
}

const LOSS_OF_PAY_NAME = /leave|late|early|miss(?:ed)?[\s-]*punch|comp[\s-]*off/i;

function labeledCount(value) {
    const match = String(value ?? '').match(/-?\d+(?:\.\d+)?/);
    if (!match) return 0;
    const count = Number(match[0]);
    return Number.isFinite(count) ? count : 0;
}

/** Payroll sheet columns: fine, advance, and loan stay separate. Anything else except loss of pay is other. */
function splitSheetDeductions(rows) {
    let fineAmount = 0;
    let advanceAmount = 0;
    let loanAmount = 0;
    for (const row of rows || []) {
        const name = String(row?.component || '');
        const amount = money(row?.amount);
        if (!amount || LOSS_OF_PAY_NAME.test(name)) continue;
        if (/advance/i.test(name)) advanceAmount = money(advanceAmount + amount);
        else if (/loan/i.test(name)) loanAmount = money(loanAmount + amount);
        else if (/fine/i.test(name)) fineAmount = money(fineAmount + amount);
    }
    return { fineAmount, advanceAmount, loanAmount };
}

const ZOHO_MONTHLY_EARNINGS = [
    'Basic Salary',
    'Other Allowance',
    'House Rental Allowance',
    'Vehicle Allowance',
    'Fuel Allowance',
    'Phone Allowance',
    'Overtime Hours',
    'Overtime Days',
    'Reward',
];

/** Same loss-of-pay lines as the salary slip card. */
const ZOHO_LOSS_OF_PAY = [
    'Late in',
    'Late out',
    'Missed Punch',
    'Authorized Leave',
    'Unauthorized Leave',
    'Sandwich Leave',
    'Annual Leave',
];

function namedAmount(rows, name) {
    const want = String(name || '').trim().toLowerCase();
    if (!want) return 0;
    for (const row of rows || []) {
        if (String(row?.component || '').trim().toLowerCase() === want) return money(row?.amount);
    }
    return 0;
}

/** Loss of pay total on the salary slip card and the payroll sheet. */
export function salarySlipLossOfPay(slip) {
    return ZOHO_LOSS_OF_PAY.reduce(
        (sum, name) => money(sum + namedAmount(slip?.deductions, name)),
        0,
    );
}

function sheetPresentDaysOf(slip) {
    const punched = slip?.attendance?.punchedPresentDays;
    if (punched == null || punched === '') return labeledCount(slip?.attendance?.presentDays);
    const count = Number(punched);
    return Number.isFinite(count) ? count : 0;
}

/** Same figure as the salary slip Zoho salary card: monthly earnings + annual leave and ticket − loss of pay. */
export function salarySlipZohoPay(slip) {
    const monthly = ZOHO_MONTHLY_EARNINGS.reduce(
        (sum, name) => money(sum + namedAmount(slip?.earnings, name)),
        0,
    );
    const leave = money(slip?.summary?.leaveSalary?.amount)
        || namedAmount(slip?.yearlyEarnings, 'Leave Salary')
        || namedAmount(slip?.earnings, 'Leave Salary');
    const ticket = money(slip?.summary?.airTicket?.amount)
        || namedAmount(slip?.yearlyEarnings, 'Travel Allowance')
        || namedAmount(slip?.earnings, 'Ticket');
    return money(Math.max(0, monthly + leave + ticket - salarySlipLossOfPay(slip)));
}

/** Monthly pay, additions, deductions, and net taken from one salary slip. */
export function salarySlipPayrollFigures(slip) {
    const earnings = Array.isArray(slip?.earnings) ? slip.earnings : [];
    let extra = 0;
    let overtime = 0;
    let structure = 0;
    let basicSalary = 0;
    for (const row of earnings) {
        const name = String(row?.component || '');
        const amount = money(row?.amount);
        if (/basic salary/i.test(name)) basicSalary = amount;
        if (ADDITION_EARNING.test(name)) {
            extra = money(extra + amount);
            if (/overtime/i.test(name)) overtime = money(overtime + amount);
        } else {
            structure = money(structure + amount);
        }
    }
    const reconciliation = slip?.reconciliation || {};
    const netSalary = money(slip?.netSalary);
    const monthlySalary = structure || money(slip?.summary?.monthlySalary);
    const buckets = splitSheetDeductions(slip?.deductions);
    const zohoSalary = salarySlipZohoPay(slip);
    const cardLossOfPay = salarySlipLossOfPay(slip);
    const utilityAmount = namedAmount(slip?.deductions, 'Utility Excess');
    const cardOtherDeduction = money(
        buckets.fineAmount + buckets.advanceAmount + buckets.loanAmount + utilityAmount,
    );
    // Same as the slip: Zoho salary minus loan, fine, utility, and salary advance.
    const actualSalary = money(Math.max(0, zohoSalary - cardOtherDeduction));
    return {
        monthKey: monthKeyOf(slip?.monthKey),
        monthlySalary,
        basicSalary,
        otherAllowance: money(Math.max(0, monthlySalary - basicSalary)),
        presentDays: labeledCount(slip?.attendance?.presentDays),
        sheetPresentDays: sheetPresentDaysOf(slip),
        leaveDays: labeledCount(slip?.attendance?.workingDayLeaves),
        rewardAdditions: money(Math.max(0, extra - overtime)),
        grossSalary: money(slip?.grossEarnings) || money(monthlySalary + extra),
        fineAmount: buckets.fineAmount,
        advanceAmount: buckets.advanceAmount,
        loanAmount: buckets.loanAmount,
        sheetOtherDeduction: utilityAmount,
        extra,
        ot: overtime,
        deduction: money(cardLossOfPay + cardOtherDeduction),
        lossOfPay: cardLossOfPay,
        sheetLossOfPay: cardLossOfPay,
        otherDeduction: cardOtherDeduction,
        actualSalary,
        netSalary,
        zohoSalary,
        overtimeHours: money(slip?.summary?.overtimeHoursCount),
        grossEarnings: money(slip?.grossEarnings),
        attendance: money(reconciliation.attendance),
        salaryAdvance: money(reconciliation.salaryAdvance),
        loan: money(reconciliation.loan),
        fine: money(reconciliation.fine),
        utilityExcess: money(reconciliation.utilityExcess),
        deductions: (Array.isArray(slip?.deductions) ? slip.deductions : []).map((row) => ({
            component: String(row?.component || '').trim(),
            basis: String(row?.basis || '').trim(),
            amount: money(row?.amount),
        })),
    };
}

export async function collectSalarySlipPayrollFigures(employeeIds, monthKey, { concurrency = 5 } = {}) {
    const ids = [];
    const seen = new Set();
    for (const id of employeeIds || []) {
        const key = payrollFigureKey(id);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        ids.push(String(id).trim());
    }
    const map = new Map();
    if (!ids.length || !monthKeyOf(monthKey)) return map;
    let cursor = 0;
    const workers = Math.min(Math.max(1, concurrency), ids.length);
    async function worker() {
        while (cursor < ids.length) {
            const code = ids[cursor];
            cursor += 1;
            try {
                const slip = await buildSalarySlipPayload({ employeeId: code, monthKey });
                const figures = salarySlipPayrollFigures(slip);
                const key = payrollFigureKey(code);
                if (key) map.set(key, figures);
            } catch (error) {
                console.error('[salarySlipPayrollFigures]', code, monthKey, error?.message || error);
            }
        }
    }
    await Promise.all(Array.from({ length: workers }, () => worker()));
    return map;
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
        thisMonthOverrides: stored.thisMonthOverrides || live.thisMonthOverrides || {},
    };
    return recalcSalarySlip(merged);
}

export function applySalarySlipSectionPatch(slip, section, updater) {
    const draft = updater(JSON.parse(JSON.stringify(slip || {})));
    const fromDetails = new Set(['attendanceDeductions', 'loans', 'fines', 'utilities', 'thisMonthDeduction']);
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
