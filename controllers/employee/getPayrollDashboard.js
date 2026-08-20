import mongoose from 'mongoose';
import Attendance from '../../models/Attendance.js';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import EmployeeSalary from '../../models/EmployeeSalary.js';
import Fine from '../../models/Fine.js';
import Loan from '../../models/Loan.js';
import {
    isCompanyShellEmployee,
    REAL_EMPLOYEE_MONGO_FILTER,
} from '../../utils/attendanceEmployeeFilters.js';
import { resolveEmployeeFinePayableAmount } from '../../utils/finePayableAmount.js';
import { buildLoanInstallments } from '../../utils/upsertLoanPartyExpenseFromPayment.js';
import {
    getScheduledEmailTimeZone,
    getZonedParts,
} from '../../utils/scheduleDailyAtMidnight.js';
import {
    clockTimeToMinutes,
    getScheduledPunchMinutes,
    loadWorkingTimeDoc,
} from '../../utils/workingTimeHelpers.js';

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
];
const APPROVED_LOAN_STATUSES = ['Approved', 'Pending Payment to Employee', 'Paid'];
const APPROVED_FINE_STATUSES = ['Approved', 'Active', 'Paid', 'Completed'];
const LEAVE_STATUS_KEYS = ['authorized_leave', 'unauthorized_leave', 'sick_leave'];

function money(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function toK(aed) {
    return Number((money(aed) / 1000).toFixed(1));
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

function yearMonth(year, month) {
    return `${year}-${pad2(month)}`;
}

function toYearMonth(value) {
    if (!value) return null;
    const raw = String(value).trim();
    if (/^\d{4}-\d{2}$/.test(raw)) return raw;
    if (/^\d{4}-\d{2}-\d{2}/.test(raw) && !raw.includes('T')) return raw.slice(0, 7);
    const named = raw.match(/^([A-Za-z]+)\s+(\d{4})$/);
    if (named) {
        const idx = MONTH_NAMES.indexOf(named[1].toLowerCase());
        if (idx >= 0) return `${named[2]}-${pad2(idx + 1)}`;
    }
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const parts = getZonedParts(date, getScheduledEmailTimeZone());
    return `${parts.year}-${pad2(parts.month)}`;
}

function employeeDisplayName(emp) {
    return [emp?.firstName, emp?.lastName].filter(Boolean).join(' ').trim();
}

function normalizeStaffType(value) {
    return String(value || '').trim().toLowerCase() === 'site' ? 'site' : 'office';
}

function formatAedCompact(amount) {
    const n = money(amount);
    if (n >= 1_000_000) {
        const millions = n / 1_000_000;
        const digits = millions >= 10 ? 1 : 2;
        return `AED ${millions.toFixed(digits).replace(/\.0+$/, '')}M`;
    }
    if (n >= 1000) {
        const thousands = n / 1000;
        const digits = thousands >= 10 ? 0 : 1;
        return `AED ${thousands.toFixed(digits).replace(/\.0+$/, '')}K`;
    }
    return `AED ${Math.round(n)}`;
}

function employeeWorkedInMonth(emp, ym) {
    const join = toYearMonth(emp?.dateOfJoining);
    if (join && join > ym) return false;
    if (String(emp?.status || '') === 'Left User') {
        const exit = toYearMonth(emp?.noticeRequest?.exitDate);
        if (exit && exit < ym) return false;
    }
    return true;
}

function salaryComponentsTotal(entry) {
    if (!entry) return 0;
    const stored = money(entry.totalSalary) || money(entry.monthlySalary);
    if (stored > 0) return stored;
    const extras = Array.isArray(entry.additionalAllowances) ? entry.additionalAllowances : [];
    const extraSum = extras.reduce((sum, row) => sum + money(row?.amount), 0);
    const extraHasVehicle = extras.some((row) => String(row?.type || '').toLowerCase().includes('vehicle'));
    const extraHasFuel = extras.some((row) => String(row?.type || '').toLowerCase().includes('fuel'));
    return (
        money(entry.basic) +
        money(entry.houseRentAllowance) +
        money(entry.otherAllowance) +
        (extraHasVehicle ? 0 : money(entry.vehicleAllowance)) +
        (extraHasFuel ? 0 : money(entry.fuelAllowance)) +
        extraSum
    );
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

/** Monthly salary for one employee in YYYY-MM: history if it covers the month, else current salary. */
function salaryAmountForMonth(salaryDoc, ym) {
    const current = salaryComponentsTotal(salaryDoc);
    const history = Array.isArray(salaryDoc?.salaryHistory) ? salaryDoc.salaryHistory : [];

    const matching = history.filter((entry) => historyCoversMonth(entry, ym));
    if (matching.length) {
        matching.sort((a, b) => String(historyFromMonth(b) || '').localeCompare(String(historyFromMonth(a) || '')));
        return salaryComponentsTotal(matching[0]) || current;
    }

    const openRows = history.filter((entry) => !entry?.toDate);
    if (openRows.length) {
        openRows.sort((a, b) => String(historyFromMonth(b) || '').localeCompare(String(historyFromMonth(a) || '')));
        const latestOpen = openRows[0];
        const from = historyFromMonth(latestOpen);
        if (!from || from <= ym) {
            return salaryComponentsTotal(latestOpen) || current;
        }
    }

    return current;
}

function ratioPercents(office, site) {
    const total = office + site;
    if (total <= 0) return { officePct: 0, sitePct: 0 };
    if (office <= 0) return { officePct: 0, sitePct: 100 };
    if (site <= 0) return { officePct: 100, sitePct: 0 };
    const officePct = Math.round((office / total) * 100);
    return { officePct, sitePct: 100 - officePct };
}

function addMonthsYm(ym, months) {
    const match = String(ym || '').match(/^(\d{4})-(\d{2})$/);
    if (!match) return null;
    let year = Number(match[1]);
    let month = Number(match[2]) + months;
    while (month > 12) {
        month -= 12;
        year += 1;
    }
    while (month < 1) {
        month += 12;
        year -= 1;
    }
    return yearMonth(year, month);
}

function scheduleMonths(startYm, duration) {
    const months = Math.max(1, Number(duration) || 1);
    if (!startYm) return [];
    return Array.from({ length: months }, (_, i) => addMonthsYm(startYm, i)).filter(Boolean);
}

function formatAedFull(amount) {
    const n = Math.round(money(amount));
    return `AED ${n.toLocaleString('en-US')}`;
}

function emptyYearMonths() {
    return Array(12).fill(0);
}

function monthIndexFromYm(ym) {
    const match = String(ym || '').match(/^(\d{4})-(\d{2})$/);
    if (!match) return -1;
    return Number(match[2]) - 1;
}

function monthsThroughYear(year, dubai) {
    if (year < dubai.year) return 12;
    if (year > dubai.year) return 0;
    return Math.min(12, Math.max(0, Number(dubai.month) || 0));
}

function isOvertimeEligible(emp) {
    const value = emp?.overtime;
    if (value === true || value === 1) return true;
    const raw = String(value || '').trim().toLowerCase();
    return raw === 'true' || raw === 'yes' || raw === '1';
}

const OT_MULTIPLIER = 1.25;

function overtimeAmountForPunch({ timeIn, timeOut, date, week, monthlySalary }) {
    const actualIn = clockTimeToMinutes(timeIn);
    const actualOut = clockTimeToMinutes(timeOut);
    if (actualIn == null || actualOut == null || monthlySalary <= 0) return 0;

    let worked = actualOut - actualIn;
    if (worked <= 0) worked += 24 * 60;

    const scheduled = getScheduledPunchMinutes(week, date);
    let scheduledMinutes = 0;
    if (!scheduled.isOffDay) {
        scheduledMinutes = (scheduled.endMinutes ?? 18 * 60) - (scheduled.startMinutes ?? 9 * 60);
        if (scheduledMinutes <= 0) scheduledMinutes += 24 * 60;
    }

    const otMinutes = scheduled.isOffDay ? worked : Math.max(0, worked - scheduledMinutes);
    if (otMinutes <= 0) return 0;

    const dayHours = (scheduledMinutes > 0 ? scheduledMinutes : 8 * 60) / 60;
    const hourly = monthlySalary / 30 / dayHours;
    return hourly * OT_MULTIPLIER * (otMinutes / 60);
}

async function buildEmployeePayrollView({
    emp,
    salaryDoc,
    year,
    dubai,
    years,
    dropdownEmployees,
    filterEmployeeId,
}) {
    const comparisonYears = [year - 2, year - 1, year];
    const salaryByYear = {};
    for (const y of comparisonYears) {
        const months = emptyYearMonths();
        const lastMonth = monthsThroughYear(y, dubai);
        if (emp) {
            for (let month = 1; month <= lastMonth; month += 1) {
                const ym = yearMonth(y, month);
                if (!employeeWorkedInMonth(emp, ym)) continue;
                months[month - 1] = salaryAmountForMonth(salaryDoc, ym);
            }
        }
        salaryByYear[y] = months;
    }

    const selectedMonths = salaryByYear[year] || emptyYearMonths();
    const ytdThrough = year === dubai.year ? dubai.month : 12;
    const currentMonthIndex = Math.max(0, ytdThrough - 1);
    const currentSalary =
        (emp && employeeWorkedInMonth(emp, yearMonth(year, ytdThrough))
            ? selectedMonths[currentMonthIndex]
            : 0) || salaryComponentsTotal(salaryDoc);

    const salaryYearComparison = MONTH_LABELS.map((month, i) => {
        const row = { month };
        for (const y of comparisonYears) {
            row[String(y)] = toK(salaryByYear[y]?.[i] || 0);
        }
        return row;
    });

    const mongoId = emp?._id ? String(emp._id) : '';
    const from = `${year}-01-01`;
    const to = year < dubai.year ? `${year}-12-31` : year === dubai.year
        ? `${dubai.year}-${pad2(dubai.month)}-${pad2(dubai.day)}`
        : `${year - 1}-12-31`;

    const leaveStatusKeys = [...LEAVE_STATUS_KEYS, 'work_from_home'];
    const attendanceRows = mongoId
        ? await Attendance.aggregate([
              {
                  $match: {
                      employeeMongoId: mongoId,
                      date: { $gte: from, $lte: to },
                      statusKey: { $in: leaveStatusKeys },
                  },
              },
              {
                  $group: {
                      _id: {
                          month: { $substr: ['$date', 0, 7] },
                          statusKey: '$statusKey',
                          leavePayType: '$leavePayType',
                      },
                      count: { $sum: 1 },
                  },
              },
          ])
        : [];

    const leaveTotals = { authorized: 0, unauthorized: 0, sick: 0, wfh: 0 };
    const lopMonthly = emptyYearMonths();
    for (const row of attendanceRows) {
        const key = String(row?._id?.statusKey || '');
        const pay = String(row?._id?.leavePayType || '').trim().toLowerCase();
        const count = Number(row?.count) || 0;
        const idx = monthIndexFromYm(row?._id?.month);
        if (key === 'authorized_leave') leaveTotals.authorized += count;
        if (key === 'unauthorized_leave') leaveTotals.unauthorized += count;
        if (key === 'sick_leave') leaveTotals.sick += count;
        if (key === 'work_from_home') leaveTotals.wfh += count;

        const isLop = key === 'unauthorized_leave' || (key === 'authorized_leave' && pay === 'unpaid');
        if (isLop && idx >= 0 && idx < 12) {
            const monthSalary = selectedMonths[idx] || currentSalary;
            lopMonthly[idx] += (monthSalary / 30) * count;
        }
    }

    const leaveUsedDays =
        leaveTotals.authorized + leaveTotals.unauthorized + leaveTotals.sick + leaveTotals.wfh;

    const [loans, fines] = await Promise.all([
        Loan.find({
            employeeId: filterEmployeeId,
            $or: [
                { approvalStatus: { $in: APPROVED_LOAN_STATUSES } },
                { status: { $in: APPROVED_LOAN_STATUSES } },
            ],
        })
            .select('employeeId type amount duration monthStart originalMonthStart originalDuration approvalStatus status approvedDate appliedDate')
            .lean()
            .maxTimeMS(12000),
        Fine.find({
            fineStatus: { $in: APPROVED_FINE_STATUSES },
            sourceOfIncome: { $ne: 'End of Service' },
            'assignedEmployees.employeeId': filterEmployeeId,
        })
            .select('assignedEmployees employeeAmount companyAmount serviceCharge discount totalFineAmount fineAmount fineStatus sourceOfIncome payableDuration monthStart originalMonthStart originalPayableDuration responsibleFor awardedDate createdAt')
            .lean()
            .maxTimeMS(12000),
    ]);

    const loanMonthly = emptyYearMonths();
    const advanceMonthly = emptyYearMonths();
    for (const loan of loans || []) {
        const installments = buildLoanInstallments({
            ...loan,
            monthStart: loan.originalMonthStart || loan.monthStart || toYearMonth(loan.approvedDate || loan.appliedDate),
            duration: loan.originalDuration ?? loan.duration,
        });
        for (const part of installments) {
            if (!String(part.monthKey || '').startsWith(`${year}-`)) continue;
            const idx = monthIndexFromYm(part.monthKey);
            if (idx < 0) continue;
            if (loan.type === 'Advance') advanceMonthly[idx] += money(part.amount);
            else loanMonthly[idx] += money(part.amount);
        }
    }

    const fineMonthly = emptyYearMonths();
    for (const fine of fines || []) {
        const duration = Math.max(1, Number(fine.originalPayableDuration ?? fine.payableDuration) || 1);
        const startYm = toYearMonth(fine.originalMonthStart || fine.monthStart || fine.awardedDate || fine.createdAt);
        const months = scheduleMonths(startYm, duration);
        const payable = resolveEmployeeFinePayableAmount(fine, filterEmployeeId);
        if (payable <= 0) continue;
        const perMonth = payable / duration;
        for (const ym of months) {
            if (!ym.startsWith(`${year}-`)) continue;
            const idx = monthIndexFromYm(ym);
            if (idx >= 0) fineMonthly[idx] += perMonth;
        }
    }

    const toMonthSeries = (values) => MONTH_LABELS.map((month, i) => ({ month, value: Number((values[i] || 0).toFixed(2)) }));
    const sumMonths = (values, through = 12) =>
        values.slice(0, through).reduce((sum, n) => sum + money(n), 0);

    const lopTotal = sumMonths(lopMonthly);
    const loanTotal = sumMonths(loanMonthly);
    const advanceTotal = sumMonths(advanceMonthly);
    const fineTotal = sumMonths(fineMonthly);
    const totalDeductions = lopTotal + loanTotal + advanceTotal + fineTotal;
    const salaryYtd = sumMonths(selectedMonths, ytdThrough);
    const deductionsYtd =
        sumMonths(lopMonthly, ytdThrough) +
        sumMonths(loanMonthly, ytdThrough) +
        sumMonths(advanceMonthly, ytdThrough) +
        sumMonths(fineMonthly, ytdThrough);
    const netPaidYtd = Math.max(0, salaryYtd - deductionsYtd);

    return {
        view: 'employee',
        year,
        employeeId: filterEmployeeId,
        years,
        comparisonYears,
        employees: dropdownEmployees,
        employee: {
            employeeId: filterEmployeeId,
            name: emp ? employeeDisplayName(emp) || filterEmployeeId : filterEmployeeId,
            staffType: emp ? normalizeStaffType(emp.staffType) : 'office',
        },
        summary: {
            currentSalary: formatAedFull(currentSalary),
            totalDeductions: formatAedFull(totalDeductions),
            netPaidYtd: formatAedFull(netPaidYtd),
            leaveUsed: `${leaveUsedDays} Day${leaveUsedDays === 1 ? '' : 's'}`,
            leaveUsedDays,
        },
        salaryYearComparison,
        lossOfPayMonthly: toMonthSeries(lopMonthly),
        lossOfPayTotal: formatAedFull(lopTotal),
        loanMonthly: toMonthSeries(loanMonthly),
        loanTotal: formatAedFull(loanTotal),
        advanceMonthly: toMonthSeries(advanceMonthly),
        advanceTotal: formatAedFull(advanceTotal),
        fineMonthly: toMonthSeries(fineMonthly),
        fineTotal: formatAedFull(fineTotal),
        leaveByType: [
            { name: 'Authorized', value: leaveTotals.authorized },
            { name: 'Unauthorized', value: leaveTotals.unauthorized },
            { name: 'Sick', value: leaveTotals.sick },
            { name: 'Work from Home', value: leaveTotals.wfh },
        ],
    };
}

/**
 * GET /api/Employee/payroll-dashboard?year=2026&employeeId=all|VEGA-xxx
 */
export const getPayrollDashboard = async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const dubai = getZonedParts(new Date(), getScheduledEmailTimeZone());
        const requestedYear = Number(req.query.year);
        const year =
            Number.isInteger(requestedYear) && requestedYear >= 2000 && requestedYear <= 2100
                ? requestedYear
                : dubai.year;

        const requestedEmployeeId = String(req.query.employeeId || 'all').trim();
        const filterEmployeeId =
            !requestedEmployeeId || requestedEmployeeId.toLowerCase() === 'all'
                ? null
                : requestedEmployeeId;

        const todayKey = `${dubai.year}-${pad2(dubai.month)}-${pad2(dubai.day)}`;
        const from = `${year}-01-01`;
        const to = year < dubai.year ? `${year}-12-31` : year === dubai.year ? todayKey : `${year - 1}-12-31`;
        const monthsThrough = monthsThroughYear(year, dubai);
        const years = Array.from({ length: 3 }, (_, i) => dubai.year - 2 + i);

        const employeeRows = await EmployeeBasic.find({
            employeeId: { $ne: 'VEGA-HR-0000' },
            ...REAL_EMPLOYEE_MONGO_FILTER,
        })
            .select('_id employeeId firstName lastName staffType status dateOfJoining overtime noticeRequest.exitDate profileStatus')
            .sort({ firstName: 1, lastName: 1 })
            .lean()
            .maxTimeMS(15000);

        const allEmployees = (employeeRows || []).filter((emp) => !isCompanyShellEmployee(emp));
        const dropdownEmployees = allEmployees
            .filter((emp) => {
                if (String(emp.status || '') === 'Left User') return false;
                const profile = String(emp.profileStatus || '').toLowerCase();
                return profile === 'active' || profile === '';
            })
            .map((emp) => ({
                employeeId: emp.employeeId,
                name: employeeDisplayName(emp) || emp.employeeId,
                staffType: normalizeStaffType(emp.staffType),
            }));

        let scopedEmployees = allEmployees;
        if (filterEmployeeId) {
            const selectedId = filterEmployeeId.toLowerCase();
            scopedEmployees = allEmployees.filter(
                (emp) => String(emp.employeeId || '').trim().toLowerCase() === selectedId,
            );
        }

        const scopedCodes = scopedEmployees.map((emp) => emp.employeeId).filter(Boolean);
        const scopedMongoIds = scopedEmployees.map((emp) => String(emp._id));
        const salaryDocs = scopedCodes.length
            ? await EmployeeSalary.find({ employeeId: { $in: scopedCodes } })
                  .select('-offerLetter.data -salaryHistory.attachment.data -salaryHistory.offerLetter.data')
                  .lean()
                  .maxTimeMS(15000)
            : [];
        const salaryByCode = new Map(
            salaryDocs.map((doc) => [String(doc.employeeId || '').trim(), doc]),
        );

        if (filterEmployeeId) {
            const emp = scopedEmployees[0] || null;
            const salaryDoc = emp
                ? salaryByCode.get(String(emp.employeeId || '').trim())
                : salaryByCode.get(filterEmployeeId) || null;
            const employeePayload = await buildEmployeePayrollView({
                emp,
                salaryDoc,
                year,
                dubai,
                years,
                dropdownEmployees,
                filterEmployeeId,
            });
            return res.status(200).json(employeePayload);
        }

        const monthlyOffice = Array(12).fill(0);
        const monthlySite = Array(12).fill(0);

        for (const emp of scopedEmployees) {
            const staffType = normalizeStaffType(emp.staffType);
            const salaryDoc = salaryByCode.get(String(emp.employeeId || '').trim());
            for (let month = 1; month <= monthsThrough; month += 1) {
                const ym = yearMonth(year, month);
                if (!employeeWorkedInMonth(emp, ym)) continue;
                const amount = salaryAmountForMonth(salaryDoc, ym);
                if (amount <= 0) continue;
                if (staffType === 'site') monthlySite[month - 1] += amount;
                else monthlyOffice[month - 1] += amount;
            }
        }

        const officeAnnual = monthlyOffice.reduce((sum, n) => sum + n, 0);
        const siteAnnual = monthlySite.reduce((sum, n) => sum + n, 0);
        const annualPayroll = officeAnnual + siteAnnual;
        const { officePct, sitePct } = ratioPercents(officeAnnual, siteAnnual);

        const monthWiseSalary = MONTH_LABELS.map((month, i) => ({
            month,
            total: toK(monthlyOffice[i] + monthlySite[i]),
        }));
        const officeVsSiteMonthly = MONTH_LABELS.map((month, i) => ({
            month,
            office: toK(monthlyOffice[i]),
            site: toK(monthlySite[i]),
        }));

        const attendanceMatch = {
            date: { $gte: from, $lte: to },
            statusKey: { $in: LEAVE_STATUS_KEYS },
        };
        if (scopedMongoIds.length) {
            attendanceMatch.employeeMongoId = { $in: scopedMongoIds };
        } else {
            attendanceMatch.employeeMongoId = { $in: [] };
        }

        const leaveRows = scopedMongoIds.length
            ? await Attendance.aggregate([
                  { $match: attendanceMatch },
                  {
                      $group: {
                          _id: {
                              employeeMongoId: '$employeeMongoId',
                              month: { $substr: ['$date', 0, 7] },
                              statusKey: '$statusKey',
                              leavePayType: '$leavePayType',
                          },
                          count: { $sum: 1 },
                      },
                  },
              ])
            : [];

        const leaveTotals = { sick: 0, authorized: 0, unauthorized: 0 };
        const empByMongo = new Map(scopedEmployees.map((emp) => [String(emp._id), emp]));
        let lopAmount = 0;
        for (const row of leaveRows) {
            const key = String(row?._id?.statusKey || '');
            const pay = String(row?._id?.leavePayType || '').trim().toLowerCase();
            const count = Number(row?.count) || 0;
            if (key === 'sick_leave') leaveTotals.sick += count;
            if (key === 'authorized_leave') leaveTotals.authorized += count;
            if (key === 'unauthorized_leave') leaveTotals.unauthorized += count;

            const isLop = key === 'unauthorized_leave' || (key === 'authorized_leave' && pay === 'unpaid');
            if (!isLop || count <= 0) continue;
            const emp = empByMongo.get(String(row?._id?.employeeMongoId || ''));
            if (!emp) continue;
            const ym = String(row?._id?.month || '');
            const salaryDoc = salaryByCode.get(String(emp.employeeId || '').trim());
            const monthly = salaryAmountForMonth(salaryDoc, ym) || salaryComponentsTotal(salaryDoc);
            lopAmount += (monthly / 30) * count;
        }

        const scopedCodeSet = new Set(scopedCodes);
        const loanQuery = {
            $or: [
                { approvalStatus: { $in: APPROVED_LOAN_STATUSES } },
                { status: { $in: APPROVED_LOAN_STATUSES } },
            ],
        };
        if (filterEmployeeId) loanQuery.employeeId = filterEmployeeId;
        else loanQuery.employeeId = { $in: scopedCodes };

        const fineQuery = {
            fineStatus: { $in: APPROVED_FINE_STATUSES },
            sourceOfIncome: { $ne: 'End of Service' },
        };
        if (filterEmployeeId) {
            fineQuery['assignedEmployees.employeeId'] = filterEmployeeId;
        }

        const [loans, fines] = await Promise.all([
            Loan.find(loanQuery)
                .select('employeeId type amount duration monthStart originalMonthStart originalDuration approvalStatus status approvedDate appliedDate')
                .lean()
                .maxTimeMS(15000),
            Fine.find(fineQuery)
                .select('assignedEmployees employeeAmount companyAmount serviceCharge discount totalFineAmount fineAmount fineStatus sourceOfIncome payableDuration monthStart originalMonthStart originalPayableDuration responsibleFor awardedDate createdAt')
                .lean()
                .maxTimeMS(15000),
        ]);

        let loanAmount = 0;
        let advanceAmount = 0;
        for (const loan of loans || []) {
            const code = String(loan.employeeId || '').trim();
            if (code && scopedCodeSet.size && !scopedCodeSet.has(code)) continue;
            const installments = buildLoanInstallments({
                ...loan,
                monthStart: loan.originalMonthStart || loan.monthStart || toYearMonth(loan.approvedDate || loan.appliedDate),
                duration: loan.originalDuration ?? loan.duration,
            });
            for (const part of installments) {
                if (String(part.monthKey || '').startsWith(`${year}-`)) {
                    if (loan.type === 'Advance') advanceAmount += money(part.amount);
                    else loanAmount += money(part.amount);
                }
            }
        }

        let fineAmount = 0;
        for (const fine of fines || []) {
            const assignees = (fine.assignedEmployees || []).filter((row) => {
                const code = String(row?.employeeId || '');
                if (!code || code === 'PENDING' || code === 'VEGA-HR-0000') return false;
                if (isCompanyShellEmployee(row)) return false;
                if (filterEmployeeId && code !== filterEmployeeId) return false;
                if (scopedCodeSet.size && !scopedCodeSet.has(code)) return false;
                return true;
            });
            const duration = Math.max(1, Number(fine.originalPayableDuration ?? fine.payableDuration) || 1);
            const startYm = toYearMonth(
                fine.originalMonthStart || fine.monthStart || fine.awardedDate || fine.createdAt,
            );
            const months = scheduleMonths(startYm, duration);
            const yearMonths = months.filter((ym) => ym.startsWith(`${year}-`));
            if (!yearMonths.length) continue;

            for (const assignee of assignees) {
                const payable = resolveEmployeeFinePayableAmount(fine, assignee.employeeId);
                if (payable <= 0) continue;
                fineAmount += (payable / duration) * yearMonths.length;
            }
        }

        const overtimeMonthlyAmounts = Array(12).fill(0);
        const overtimeEmployees = scopedEmployees.filter(isOvertimeEligible);
        const overtimeMongoIds = overtimeEmployees.map((emp) => String(emp._id));
        if (overtimeMongoIds.length && monthsThrough > 0) {
            const workingTime = await loadWorkingTimeDoc();
            const punches = await Attendance.find({
                employeeMongoId: { $in: overtimeMongoIds },
                date: { $gte: from, $lte: to },
                timeIn: { $nin: ['', null] },
                timeOut: { $nin: ['', null] },
            })
                .select('employeeMongoId date timeIn timeOut')
                .lean()
                .maxTimeMS(15000);

            for (const punch of punches || []) {
                const emp = empByMongo.get(String(punch.employeeMongoId));
                if (!emp) continue;
                const ym = String(punch.date || '').slice(0, 7);
                const idx = monthIndexFromYm(ym);
                if (idx < 0 || idx > 11) continue;
                const salaryDoc = salaryByCode.get(String(emp.employeeId || '').trim());
                const monthlySalary = salaryAmountForMonth(salaryDoc, ym);
                const week =
                    normalizeStaffType(emp.staffType) === 'site' ? workingTime.site : workingTime.office;
                overtimeMonthlyAmounts[idx] += overtimeAmountForPunch({
                    timeIn: punch.timeIn,
                    timeOut: punch.timeOut,
                    date: punch.date,
                    week,
                    monthlySalary,
                });
            }
        }

        const overtimePaidTotal = overtimeMonthlyAmounts.reduce((sum, n) => sum + n, 0);
        const overtimeMonthly = MONTH_LABELS.map((month, i) => ({
            month,
            ot: toK(overtimeMonthlyAmounts[i]),
        }));

        return res.status(200).json({
            view: filterEmployeeId ? 'employee' : 'org',
            year,
            employeeId: filterEmployeeId || 'all',
            years,
            employees: dropdownEmployees,
            employee: filterEmployeeId
                ? {
                      employeeId: filterEmployeeId,
                      name: scopedEmployees[0]
                          ? employeeDisplayName(scopedEmployees[0]) || filterEmployeeId
                          : filterEmployeeId,
                      staffType: scopedEmployees[0]
                          ? normalizeStaffType(scopedEmployees[0].staffType)
                          : 'office',
                  }
                : null,
            summary: {
                annualPayroll: formatAedCompact(annualPayroll),
                annualPayrollShort: formatAedCompact(annualPayroll),
                officeStaff: formatAedCompact(officeAnnual),
                siteStaff: formatAedCompact(siteAnnual),
                overtimePaid: formatAedCompact(overtimePaidTotal),
                officePct,
                sitePct,
            },
            monthWiseSalary,
            salaryRatio: [
                { name: 'Office Staff', value: officePct, amount: toK(officeAnnual) },
                { name: 'Site Staff', value: sitePct, amount: toK(siteAnnual) },
            ],
            officeVsSiteMonthly,
            leaveByCategory: [
                { name: 'Sick', value: leaveTotals.sick },
                { name: 'Authorized', value: leaveTotals.authorized },
                { name: 'Unauthorized', value: leaveTotals.unauthorized },
            ],
            overtimeMonthly,
            deductionsByCategory: [
                { name: 'Loss of Pay', value: toK(lopAmount) },
                { name: 'Loan', value: toK(loanAmount) },
                { name: 'Advance', value: toK(advanceAmount) },
                { name: 'Fine', value: toK(fineAmount) },
            ],
        });
    } catch (error) {
        console.error('[getPayrollDashboard]', error);
        return res.status(500).json({
            message: error.message || 'Failed to load payroll dashboard.',
        });
    }
};
