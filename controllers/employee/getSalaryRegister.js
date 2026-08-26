import mongoose from 'mongoose';
import Attendance from '../../models/Attendance.js';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import EmployeeSalary from '../../models/EmployeeSalary.js';
import EmployeeBank from '../../models/EmployeeBank.js';
import SalaryEnrollment from '../../models/SalaryEnrollment.js';
import SalaryMonthPayment from '../../models/SalaryMonthPayment.js';
import PayrollSettings from '../../models/PayrollSettings.js';
import Company from '../../models/Company.js';
import Fine from '../../models/Fine.js';
import Loan from '../../models/Loan.js';
import EmployeeHubRequest from '../../models/EmployeeHubRequest.js';
import {
    isCompanyShellEmployee,
    REAL_EMPLOYEE_MONGO_FILTER,
} from '../../utils/attendanceEmployeeFilters.js';
import { isPlaceholderEmployeeId } from '../../utils/employeeIdPrefix.js';
import {
    listActiveWorkLocations,
    normalizeStaffTypeKey,
} from '../../utils/workLocationHelpers.js';
import { serializePayrollSettings } from './payrollSettingsController.js';
import { resolveEmployeeFinePayableAmount } from '../../utils/finePayableAmount.js';
import { buildLoanInstallments } from '../../utils/upsertLoanPartyExpenseFromPayment.js';
import {
    getScheduledEmailTimeZone,
    getZonedParts,
} from '../../utils/scheduleDailyAtMidnight.js';
import { isJwtSystemSuperUser } from '../../utils/systemSuperUser.js';
import { sendMailLater } from '../../utils/salaryEnrollmentApprovalNotify.js';
import {
    clockTimeToMinutes,
    getScheduledPunchMinutes,
    loadWorkingTimeDoc,
    getWeekForStaffType,
} from '../../utils/workingTimeHelpers.js';

const MONTH_FULL = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES = MONTH_FULL.map((name) => name.toLowerCase());
const APPROVED_LOAN_STATUSES = ['Approved', 'Pending Payment to Employee', 'Paid'];
const APPROVED_FINE_STATUSES = ['Approved', 'Active', 'Paid', 'Completed'];
const OT_MULTIPLIER = 1.25;

function money(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

function lastDayOfMonth(year, month) {
    return new Date(year, month, 0).getDate();
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

function monthLabel(ym) {
    const match = String(ym || '').match(/^(\d{4})-(\d{2})$/);
    if (!match) return ym || '';
    const monthName = MONTH_FULL[Number(match[2]) - 1];
    return monthName ? `${monthName} ${match[1]}` : ym;
}

/** Salary-month list label, e.g. "1 Aug 2026". */
function monthRowLabel(ym) {
    const match = String(ym || '').match(/^(\d{4})-(\d{2})$/);
    if (!match) return ym || '';
    const short = MONTH_SHORT[Number(match[2]) - 1];
    return short ? `1 ${short} ${match[1]}` : ym;
}

function buildEnrolledUserRows(enrollments, { employees = [], salaryByCode, otByKey, deductionByKey, salaryYm } = {}) {
    const empByCode = new Map(
        (employees || []).map((emp) => [String(emp.employeeId || '').trim(), emp]),
    );
    const rows = [];
    for (const row of enrollments || []) {
        const code = String(row.employeeId || '').trim();
        if (!code) continue;
        const emp = empByCode.get(code);
        const name = emp ? `${emp.firstName || ''} ${emp.lastName || ''}`.trim() : code;
        const from = row.fromMonth;
        const ym = salaryYm && from && from <= salaryYm ? salaryYm : from;
        const salaryDoc = salaryByCode?.get?.(code);
        const empMonthly = salaryDoc ? salaryAmountForMonth(salaryDoc, ym) : 0;
        const empBasic = salaryDoc ? basicAmountForMonth(salaryDoc, ym) : 0;
        const empOt = otByKey?.get(`${code}|${ym}`) || 0;
        const empDeduction = deductionByKey?.get(`${code}|${ym}`) || 0;
        rows.push({
            employeeId: code,
            monthKey: from,
            month: monthLabel(from),
            enrollUser: name || code,
            monthlySalary: roundMoney(empMonthly),
            actualSalary: roundMoney(Math.max(0, empMonthly + empOt - empDeduction)),
            basicSalary: roundMoney(empBasic),
            ot: roundMoney(empOt),
            deduction: roundMoney(empDeduction),
        });
    }
    rows.sort((a, b) =>
        String(a.enrollUser).localeCompare(String(b.enrollUser), undefined, { sensitivity: 'base' }),
    );
    return rows.map((row, index) => ({ ...row, slNo: index + 1 }));
}

async function enrolledUsersForEmptyRegister(enrollments) {
    if (!enrollments?.length) return [];
    const codes = [...new Set(enrollments.map((row) => row.employeeId).filter(Boolean))];
    if (!codes.length) return [];
    const [employeeRows, salaryDocs] = await Promise.all([
        EmployeeBasic.find({
            employeeId: { $in: codes },
            ...REAL_EMPLOYEE_MONGO_FILTER,
        })
            .select('employeeId firstName lastName')
            .lean()
            .maxTimeMS(8000),
        EmployeeSalary.find({ employeeId: { $in: codes } })
            .select('-offerLetter.data -salaryHistory.attachment.data -salaryHistory.offerLetter.data')
            .lean()
            .maxTimeMS(8000),
    ]);
    const employees = (employeeRows || []).filter((emp) => !isCompanyShellEmployee(emp));
    const salaryByCode = new Map(
        (salaryDocs || []).map((doc) => [String(doc.employeeId || '').trim(), doc]),
    );
    return buildEnrolledUserRows(enrollments, { employees, salaryByCode });
}

function toMonthDay(value) {
    const s = String(value || '').trim();
    const iso = s.match(/^\d{4}-\d{2}-(\d{2})/);
    const n = iso ? Number(iso[1]) : Number(s);
    if (!Number.isInteger(n) || n < 1) return '';
    return String(Math.min(28, n));
}

function titleCaseLocation(key) {
    return String(key || '')
        .replace(/-/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase()) || 'Office';
}

const PENDING_FINANCE_STATUSES = ['Pending', 'Pending HR', 'Pending Accounts', 'Pending Authorization'];
const ATTENDANCE_CORRECTION_KINDS = new Set(['yellow', 'future_late', 'future_early']);
const LEAVE_REQUEST_KINDS = new Set(['leave', 'future_leave', 'future_annual']);

function pendingRequestCategory(kind, requestedStatusKey) {
    const status = String(requestedStatusKey || '').trim().toLowerCase();
    const k = String(kind || '').trim().toLowerCase();
    if (status === 'compoff_leave' || k === 'compoff' || k === 'compoff_leave') return 'compoff';
    if (ATTENDANCE_CORRECTION_KINDS.has(k)) return 'attendance';
    if (LEAVE_REQUEST_KINDS.has(k)) return 'leave';
    return 'leave';
}

function monthDateRange(ym) {
    const match = String(ym || '').match(/^(\d{4})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    return {
        from: `${ym}-01`,
        to: `${ym}-${pad2(lastDayOfMonth(year, month))}`,
    };
}

async function buildGroupPendingRequests(people, monthKey) {
    const rows = Array.isArray(people) ? people : [];
    if (!rows.length) return [];

    const range = monthDateRange(monthKey);
    const empByMongo = new Map(rows.map((emp) => [String(emp._id), emp]));
    const empByCode = new Map(rows.map((emp) => [String(emp.employeeId || '').trim(), emp]));
    const mongoIds = rows.map((emp) => String(emp._id));
    const objectIds = rows.map((emp) => emp._id).filter(Boolean);
    const codes = rows.map((emp) => String(emp.employeeId || '').trim()).filter(Boolean);

    const dateFilter = range
        ? {
              $or: [
                  { date: { $gte: range.from, $lte: range.to } },
                  { leaveRequestFromDate: { $gte: range.from, $lte: range.to } },
              ],
          }
        : {};

    const [attendanceRows, unmarkedRows, loans, fines, hubRows] = await Promise.all([
        mongoIds.length
            ? Attendance.find({
                  employeeMongoId: { $in: mongoIds },
                  leaveRequestStatus: 'pending',
                  ...dateFilter,
              })
                  .select(
                      '_id employeeMongoId employeeId employeeName date leaveRequestKind requestedStatusKey requestedStatusLabel leaveRequestGroupId leaveRequestFromDate leaveRequestToDate',
                  )
                  .lean()
                  .maxTimeMS(12000)
            : [],
        range && mongoIds.length
            ? Attendance.aggregate([
                  {
                      $match: {
                          employeeMongoId: { $in: mongoIds },
                          date: { $gte: range.from, $lte: range.to },
                          statusKey: 'not_marked',
                      },
                  },
                  { $group: { _id: '$employeeMongoId', days: { $sum: 1 } } },
              ])
            : [],
        codes.length
            ? Loan.find({
                  employeeId: { $in: codes },
                  $or: [
                      { status: { $in: PENDING_FINANCE_STATUSES } },
                      { approvalStatus: { $in: PENDING_FINANCE_STATUSES } },
                  ],
              })
                  .select('_id employeeId type status approvalStatus amount')
                  .lean()
                  .maxTimeMS(8000)
            : [],
        codes.length
            ? Fine.find({
                  fineStatus: { $in: PENDING_FINANCE_STATUSES },
                  'assignedEmployees.employeeId': { $in: codes },
              })
                  .select('_id fineId fineStatus fineType assignedEmployees')
                  .lean()
                  .maxTimeMS(8000)
            : [],
        objectIds.length
            ? EmployeeHubRequest.find({
                  status: 'Pending',
                  $or: [{ requester: { $in: objectIds } }, { requesterEmpId: { $in: codes } }],
              })
                  .select('_id kind requester requesterEmpId requesterName')
                  .lean()
                  .maxTimeMS(8000)
                  .catch(() => [])
            : [],
    ]);

    const items = [];
    const seenLeaveGroups = new Set();

    const pushItem = (emp, payload) => {
        if (!emp) return;
        items.push({
            employeeId: String(emp.employeeId || '').trim(),
            mongoId: String(emp._id),
            name: `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || emp.employeeId,
            staffType: normalizeStaffTypeKey(emp.staffType),
            ...payload,
        });
    };

    for (const row of attendanceRows || []) {
        const emp =
            empByMongo.get(String(row.employeeMongoId || '')) ||
            empByCode.get(String(row.employeeId || '').trim());
        const category = pendingRequestCategory(row.leaveRequestKind, row.requestedStatusKey);
        if (category === 'leave' || category === 'compoff') {
            const groupKey = String(row.leaveRequestGroupId || row._id);
            if (seenLeaveGroups.has(groupKey)) continue;
            seenLeaveGroups.add(groupKey);
        }
        const label =
            String(row.requestedStatusLabel || '').trim() ||
            (category === 'attendance' ? 'Attendance correction' : category === 'compoff' ? 'Comp-off request' : 'Leave request');
        pushItem(emp, {
            id: `att-${row._id}`,
            category,
            title: label,
            detail: String(row.leaveRequestFromDate || row.date || ''),
            dateKey: String(row.leaveRequestFromDate || row.date || ''),
        });
    }

    for (const row of unmarkedRows || []) {
        const emp = empByMongo.get(String(row._id || ''));
        const days = Number(row.days) || 0;
        pushItem(emp, {
            id: `unmarked-${row._id}`,
            category: 'attendance',
            title: 'Attendance not marked',
            detail: `${days} day${days === 1 ? '' : 's'} in this month`,
            dateKey: range?.from || '',
        });
    }

    for (const loan of loans || []) {
        const emp = empByCode.get(String(loan.employeeId || '').trim());
        const kind = String(loan.type || 'Loan');
        pushItem(emp, {
            id: `loan-${loan._id}`,
            category: 'finance',
            title: `${kind} approval`,
            detail: String(loan.approvalStatus || loan.status || 'Pending'),
            dateKey: '',
        });
    }

    for (const fine of fines || []) {
        const assignees = Array.isArray(fine.assignedEmployees) ? fine.assignedEmployees : [];
        const matched = assignees
            .map((row) => empByCode.get(String(row?.employeeId || '').trim()))
            .filter(Boolean);
        const targets = matched.length ? matched : [];
        for (const emp of targets) {
            pushItem(emp, {
                id: `fine-${fine._id}-${emp.employeeId}`,
                category: 'finance',
                title: 'Fine approval',
                detail: String(fine.fineStatus || 'Pending'),
                dateKey: '',
            });
        }
    }

    for (const hub of hubRows || []) {
        const emp =
            empByMongo.get(String(hub.requester || '')) ||
            empByCode.get(String(hub.requesterEmpId || '').trim());
        const kind = String(hub.kind || '').trim().toLowerCase();
        let category = 'finance';
        let title = 'Request pending';
        if (kind === 'leave') {
            category = 'leave';
            title = 'Leave request';
        } else if (kind === 'advance') {
            title = 'Advance request';
        } else if (kind === 'loan') {
            title = 'Loan request';
        } else if (kind === 'utility') {
            title = 'Utility bill request';
        } else if (kind === 'fine') {
            title = 'Fine request';
        } else if (kind === 'salary') {
            title = 'Salary request';
        }
        pushItem(emp, {
            id: `hub-${hub._id}`,
            category,
            title,
            detail: 'Pending approval',
            dateKey: '',
        });
    }

    items.sort((a, b) => {
        const dateCmp = String(b.dateKey || '').localeCompare(String(a.dateKey || ''));
        if (dateCmp) return dateCmp;
        return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' });
    });
    return items;
}

async function buildEnrollmentOverview(enrollments, monthKey) {
    const enrollmentRows = Array.isArray(enrollments) ? enrollments : [];
    const enrollmentById = new Map();
    for (const row of enrollmentRows) {
        if (typeof row === 'string') {
            const id = String(row || '').trim();
            if (id) enrollmentById.set(id, { employeeId: id });
            continue;
        }
        const id = String(row?.employeeId || '').trim();
        if (id) enrollmentById.set(id, row);
    }
    const enrolledSet = new Set(enrollmentById.keys());
    const [companies, employeeRows, locations] = await Promise.all([
        Company.find({ status: 'Active' })
            .select('name nickName companyId')
            .sort({ name: 1 })
            .lean()
            .maxTimeMS(8000),
        EmployeeBasic.find({
            employeeId: { $nin: ['', 'VEGA-HR-0000'] },
            status: { $ne: 'Left User' },
            profileStatus: 'active',
            ...REAL_EMPLOYEE_MONGO_FILTER,
        })
            .select('employeeId company lastName firstName staffType designation')
            .lean()
            .maxTimeMS(12000),
        listActiveWorkLocations().catch(() => []),
    ]);

    const people = (employeeRows || []).filter((emp) => {
        const code = String(emp?.employeeId || '').trim();
        if (!code || isPlaceholderEmployeeId(code) || isCompanyShellEmployee(emp)) return false;
        return true;
    });

    const locationRows = Array.isArray(locations) && locations.length
        ? locations
        : [
            { key: 'office', label: 'Office' },
            { key: 'site', label: 'Site' },
        ];
    const payrollKeys = ['default', ...locationRows.map((row) => `group:${row.key}`)];
    const payrollDocs = await PayrollSettings.find({ key: { $in: payrollKeys } })
        .lean()
        .maxTimeMS(8000);
    const docByKey = new Map(
        (payrollDocs || []).map((doc) => [String(doc.key || ''), doc]),
    );
    const defaultDoc = docByKey.get('default') || null;
    const defaultDay = toMonthDay(defaultDoc?.salaryProcessingDate);

    let enrolled = 0;
    const byCompany = new Map();
    const byLocation = new Map();
    for (const loc of locationRows) {
        const key = normalizeStaffTypeKey(loc.key);
        const groupDoc = docByKey.get(`group:${key}`);
        byLocation.set(key, {
            key,
            label: String(loc.label || titleCaseLocation(key)).trim() || titleCaseLocation(key),
            enrolled: 0,
            totalActive: 0,
            salaryProcessingDate: toMonthDay(groupDoc?.salaryProcessingDate) || defaultDay,
            policySource: groupDoc ? 'group' : 'main',
            policy: serializePayrollSettings(groupDoc || defaultDoc),
        });
    }

    const companyById = new Map(
        (companies || []).map((company) => [
            String(company._id),
            String(company.nickName || company.name || '').trim(),
        ]),
    );

    const employees = [];
    for (const emp of people) {
        const code = String(emp.employeeId).trim();
        const enrollment = enrollmentById.get(code);
        const isEnrolled = Boolean(enrollment);
        if (isEnrolled) enrolled += 1;
        const companyKey = emp.company ? String(emp.company) : '';
        const companyName = companyKey ? companyById.get(companyKey) || '' : '';
        if (companyKey) {
            const stats = byCompany.get(companyKey) || { enrolled: 0, totalActive: 0 };
            stats.totalActive += 1;
            if (isEnrolled) stats.enrolled += 1;
            byCompany.set(companyKey, stats);
        }

        const locKey = normalizeStaffTypeKey(emp.staffType);
        let locStats = byLocation.get(locKey);
        if (!locStats) {
            const groupDoc = docByKey.get(`group:${locKey}`);
            locStats = {
                key: locKey,
                label: titleCaseLocation(locKey),
                enrolled: 0,
                totalActive: 0,
                salaryProcessingDate: toMonthDay(groupDoc?.salaryProcessingDate) || defaultDay,
                policySource: groupDoc ? 'group' : 'main',
                policy: serializePayrollSettings(groupDoc || defaultDoc),
            };
            byLocation.set(locKey, locStats);
        }
        locStats.totalActive += 1;
        if (isEnrolled) locStats.enrolled += 1;

        employees.push({
            employeeId: code,
            mongoId: String(emp._id),
            name: `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || code,
            designation: String(emp.designation || '').trim(),
            staffType: locKey,
            locationLabel: locStats.label,
            companyName,
            enrolled: isEnrolled,
            fromMonth: String(enrollment?.fromMonth || '').trim(),
            salaryDate: toMonthDay(enrollment?.salaryDate),
        });
    }

    employees.sort((a, b) =>
        String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }),
    );

    const pendingRequests = await buildGroupPendingRequests(people, monthKey);

    return {
        enrolled,
        totalActive: people.length,
        companies: (companies || []).map((company) => {
            const stats = byCompany.get(String(company._id)) || { enrolled: 0, totalActive: 0 };
            return {
                companyId: String(company.companyId || company._id),
                name: String(company.nickName || company.name || 'Company').trim(),
                enrolled: stats.enrolled,
                totalActive: stats.totalActive,
            };
        }),
        workLocations: [...byLocation.values()],
        employees,
        pendingRequests,
    };
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

function salaryAmountForMonth(salaryDoc, ym) {
    const entry = historyEntryForMonth(salaryDoc, ym);
    return salaryComponentsTotal(entry) || salaryComponentsTotal(salaryDoc);
}

function basicAmountForMonth(salaryDoc, ym) {
    const entry = historyEntryForMonth(salaryDoc, ym);
    return money(entry?.basic) || money(salaryDoc?.basic);
}

function isOvertimeEligible(emp) {
    const value = emp?.overtime;
    if (value === true || value === 1) return true;
    const raw = String(value || '').trim().toLowerCase();
    return raw === 'true' || raw === 'yes' || raw === '1';
}

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
    return `${year}-${pad2(month)}`;
}

function scheduleMonths(startYm, duration) {
    const months = Math.max(1, Number(duration) || 1);
    if (!startYm) return [];
    return Array.from({ length: months }, (_, i) => addMonthsYm(startYm, i)).filter(Boolean);
}

function roundMoney(value) {
    return Math.round(money(value) * 100) / 100;
}

function listMonthsInclusive(fromYm, toYm) {
    const months = [];
    let cursor = fromYm;
    while (cursor && cursor <= toYm) {
        months.push(cursor);
        const next = addMonthsYm(cursor, 1);
        if (!next || next === cursor) break;
        cursor = next;
    }
    return months;
}

function paymentTypeFromBank(bank) {
    const iban = String(bank?.ibanNumber || '').trim();
    const account = String(bank?.accountNumber || '').trim();
    if (iban) return 'WPS';
    if (account) return 'Bank Transfer';
    return 'Cash';
}

function companyDisplayName(company) {
    if (!company || typeof company !== 'object') return '';
    return String(company.nickName || company.name || '').trim();
}

function emptyRegisterPayload() {
    return { fromMonth: null, toMonth: null, months: [] };
}

function serializeMonthPayment(doc) {
    if (!doc) return null;
    return {
        id: String(doc._id),
        monthKey: String(doc.monthKey || ''),
        paymentNo: Number(doc.paymentNo) || 0,
        selectedIds: (doc.employeeIds || []).map((id) => String(id || '').trim()).filter(Boolean),
        processed: true,
        createdAt: doc.createdAt || null,
    };
}

async function listMonthPayments(monthKey) {
    if (!monthKey) return [];
    const rows = await SalaryMonthPayment.find({ monthKey })
        .sort({ paymentNo: 1 })
        .lean()
        .maxTimeMS(8000);
    return (rows || []).map(serializeMonthPayment).filter(Boolean);
}

function enrollmentFromMonth(row) {
    return toYearMonth(row?.fromMonth) || toYearMonth(row?.monthKey) || toYearMonth(row?.createdAt);
}

/** Recurring salary processing day 1–28. Accepts "25" or leftover YYYY-MM-DD. */
function parseProcessDay(value) {
    const s = String(value || '').trim();
    if (!s) return 0;
    const iso = s.match(/^\d{4}-\d{2}-(\d{2})/);
    const n = iso ? Number(iso[1]) : Number(s);
    if (!Number.isInteger(n) || n < 1) return 0;
    return Math.min(28, n);
}

function resolveProcessDay(settings, enrollments) {
    const fromSettings = parseProcessDay(settings?.salaryProcessingDate);
    if (fromSettings) return fromSettings;
    for (const row of enrollments || []) {
        const day = parseProcessDay(row.processDate || row.salaryDate);
        if (day) return day;
    }
    return 0;
}

/**
 * Latest month that may appear on the salary list.
 * The current calendar month is listed only after the salary processing date.
 */
function lastOpenSalaryMonth(currentYm, processDay, todayDay) {
    if (!processDay || Number(todayDay) < Number(processDay)) {
        return addMonthsYm(currentYm, -1);
    }
    return currentYm;
}

/**
 * GET /api/Employee/salary-register
 * One row per month from policy start (or first enrollment) through the last open month.
 * Months that are not open yet are omitted (no dummy/preview row).
 */
export const getSalaryRegister = async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const payrollDoc = await PayrollSettings.findOne({ key: 'default' })
            .select('hiddenSalaryMonths salaryProcessingDate salaryProcessStartMonth')
            .lean()
            .maxTimeMS(5000);
        const hiddenMonths = new Set(
            (payrollDoc?.hiddenSalaryMonths || []).map((ym) => String(ym || '').trim()).filter(Boolean),
        );

        const dubai = getZonedParts(new Date(), getScheduledEmailTimeZone());
        const currentYm = `${dubai.year}-${pad2(dubai.month)}`;
        const todayDay = Number(dubai.day) || 0;
        const detailYm = toYearMonth(req.params.monthKey || req.query.month);

        const enrollmentDocs = await SalaryEnrollment.find({})
            .select('employeeId fromMonth monthKey createdAt processDate salaryDate')
            .lean()
            .maxTimeMS(8000);

        const enrollments = [];
        for (const row of enrollmentDocs || []) {
            const employeeId = String(row.employeeId || '').trim();
            const fromMonth = enrollmentFromMonth(row);
            if (!employeeId || !fromMonth) continue;
            enrollments.push({
                employeeId,
                fromMonth,
                processDate: row.processDate,
                salaryDate: row.salaryDate,
            });
        }

        const enrollmentOverview = await buildEnrollmentOverview(enrollments, detailYm || currentYm);

        const processDay = resolveProcessDay(payrollDoc, enrollments);
        const lastOpenYm = lastOpenSalaryMonth(currentYm, processDay, todayDay);
        const firstEnrollmentYm = enrollments.reduce(
            (min, row) => (!min || row.fromMonth < min ? row.fromMonth : min),
            null,
        );
        const policyStartYm = toYearMonth(payrollDoc?.salaryProcessStartMonth);

        // Month rows follow the Main policy calendar, not the first enrollment month.
        let startYm = policyStartYm || firstEnrollmentYm || null;
        if (startYm && lastOpenYm && startYm > lastOpenYm && !policyStartYm) {
            startYm = lastOpenYm;
        }

        const waitingForOpenMonth = Boolean(startYm && lastOpenYm && startYm > lastOpenYm);
        const waitingForProcessingDate = Boolean(
            waitingForOpenMonth || (processDay && todayDay < processDay && startYm === currentYm),
        );
        const nextOpenMonthKey = waitingForOpenMonth
            ? startYm
            : processDay && todayDay < processDay
                ? currentYm
                : null;

        const registerMeta = {
            enrolledCount: enrollments.length,
            salaryProcessingDate: processDay ? String(processDay) : '',
            salaryProcessStartMonth: policyStartYm || '',
            waitingForProcessingDate,
            currentMonth: monthLabel(currentYm),
            currentMonthKey: currentYm,
            nextOpenMonth: nextOpenMonthKey ? monthLabel(nextOpenMonthKey) : '',
            nextOpenMonthKey: nextOpenMonthKey || '',
            hiddenMonthCount: hiddenMonths.size,
        };

        if (!startYm) {
            return res.status(200).json({
                ...emptyRegisterPayload(),
                ...registerMeta,
                employees: detailYm ? [] : undefined,
                payments: detailYm ? await listMonthPayments(detailYm) : undefined,
                enrolledUsers: await enrolledUsersForEmptyRegister(enrollments),
                enrollmentOverview,
            });
        }

        // Policy start is still in the future: no preview row until that month opens.
        if (startYm > lastOpenYm) {
            if (detailYm && detailYm !== startYm) {
                return res.status(404).json({
                    message: `${monthLabel(detailYm)} is not open yet.`,
                });
            }
            return res.status(200).json({
                ...emptyRegisterPayload(),
                ...registerMeta,
                employees: detailYm ? [] : undefined,
                payments: detailYm ? await listMonthPayments(detailYm) : undefined,
                enrolledUsers: await enrolledUsersForEmptyRegister(enrollments),
                enrollmentOverview,
            });
        }

        const endYm = lastOpenYm;
        if (detailYm && (detailYm < startYm || detailYm > endYm)) {
            return res.status(404).json({
                message: processDay && detailYm === currentYm && todayDay < processDay
                    ? `${monthLabel(detailYm)} opens on salary processing date (${processDay}).`
                    : 'This salary month is not open yet.',
            });
        }

        const monthKeys = listMonthsInclusive(startYm, endYm);
        if (!monthKeys.length) {
            return res.status(200).json({
                ...emptyRegisterPayload(),
                ...registerMeta,
                employees: detailYm ? [] : undefined,
                payments: detailYm ? await listMonthPayments(detailYm) : undefined,
                enrolledUsers: await enrolledUsersForEmptyRegister(enrollments),
                enrollmentOverview,
            });
        }

        const endParts = String(endYm).split('-').map(Number);
        const from = `${startYm}-01`;
        const to = `${endYm}-${pad2(lastDayOfMonth(endParts[0], endParts[1]))}`;
        const enrolledCodes = [...new Set(enrollments.map((row) => row.employeeId))];
        const fromMonthByCode = new Map();
        for (const row of enrollments) {
            const prev = fromMonthByCode.get(row.employeeId);
            if (!prev || row.fromMonth < prev) fromMonthByCode.set(row.employeeId, row.fromMonth);
        }

        const employeeRows = await EmployeeBasic.find({
            employeeId: { $in: enrolledCodes },
            ...REAL_EMPLOYEE_MONGO_FILTER,
        })
            .select('_id employeeId firstName lastName staffType status dateOfJoining overtime noticeRequest.exitDate profileStatus company')
            .populate({ path: 'company', select: 'name nickName' })
            .sort({ firstName: 1, lastName: 1 })
            .lean()
            .maxTimeMS(15000);

        const employees = (employeeRows || []).filter((emp) => !isCompanyShellEmployee(emp));
        const empByMongo = new Map(employees.map((emp) => [String(emp._id), emp]));
        const empByCode = new Map(employees.map((emp) => [String(emp.employeeId || '').trim(), emp]));
        const codes = employees.map((emp) => emp.employeeId).filter(Boolean);
        const mongoIds = employees.map((emp) => String(emp._id));

        const salaryDocs = codes.length
            ? await EmployeeSalary.find({ employeeId: { $in: codes } })
                .select('-offerLetter.data -salaryHistory.attachment.data -salaryHistory.offerLetter.data')
                .lean()
                .maxTimeMS(15000)
            : [];
        const salaryByCode = new Map(
            salaryDocs.map((doc) => [String(doc.employeeId || '').trim(), doc]),
        );
        const bankDocs = codes.length
            ? await EmployeeBank.find({ employeeId: { $in: codes } })
                .select('employeeId ibanNumber accountNumber')
                .lean()
                .maxTimeMS(8000)
            : [];
        const bankByCode = new Map(
            (bankDocs || []).map((doc) => [String(doc.employeeId || '').trim(), doc]),
        );
        const pendingEmployeeIds = new Set(
            (enrollmentOverview?.pendingRequests || [])
                .map((row) => String(row?.employeeId || '').trim())
                .filter(Boolean),
        );

        const otByKey = new Map();
        const addOt = (code, ym, amount) => {
            if (!code || !ym || amount <= 0) return;
            const key = `${code}|${ym}`;
            otByKey.set(key, (otByKey.get(key) || 0) + amount);
        };

        const overtimeEmployees = employees.filter(isOvertimeEligible);
        const overtimeMongoIds = overtimeEmployees.map((emp) => String(emp._id));
        if (overtimeMongoIds.length) {
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
                const code = String(emp.employeeId || '').trim();
                const ym = String(punch.date || '').slice(0, 7);
                if (!/^\d{4}-\d{2}$/.test(ym)) continue;
                const salaryDoc = salaryByCode.get(code);
                const monthlySalary = salaryAmountForMonth(salaryDoc, ym);
                const week = getWeekForStaffType(workingTime, emp.staffType);
                addOt(code, ym, overtimeAmountForPunch({
                    timeIn: punch.timeIn,
                    timeOut: punch.timeOut,
                    date: punch.date,
                    week,
                    monthlySalary,
                }));
            }
        }

        const deductionByKey = new Map();
        const addDeduction = (code, ym, amount) => {
            if (!code || !ym || amount <= 0) return;
            const key = `${code}|${ym}`;
            deductionByKey.set(key, (deductionByKey.get(key) || 0) + amount);
        };

        const leaveRows = mongoIds.length
            ? await Attendance.aggregate([
                {
                    $match: {
                        employeeMongoId: { $in: mongoIds },
                        date: { $gte: from, $lte: to },
                        statusKey: { $in: ['authorized_leave', 'unauthorized_leave'] },
                    },
                },
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

        for (const row of leaveRows) {
            const key = String(row?._id?.statusKey || '');
            const pay = String(row?._id?.leavePayType || '').trim().toLowerCase();
            const count = Number(row?.count) || 0;
            const ym = String(row?._id?.month || '');
            const isLop = key === 'unauthorized_leave' || (key === 'authorized_leave' && pay === 'unpaid');
            if (!isLop || count <= 0 || !/^\d{4}-\d{2}$/.test(ym)) continue;
            const emp = empByMongo.get(String(row?._id?.employeeMongoId || ''));
            if (!emp) continue;
            const code = String(emp.employeeId || '').trim();
            const monthly = salaryAmountForMonth(salaryByCode.get(code), ym);
            addDeduction(code, ym, (monthly / 30) * count);
        }

        const [loans, fines] = await Promise.all([
            codes.length
                ? Loan.find({
                    employeeId: { $in: codes },
                    $or: [
                        { approvalStatus: { $in: APPROVED_LOAN_STATUSES } },
                        { status: { $in: APPROVED_LOAN_STATUSES } },
                    ],
                })
                    .select('employeeId type amount duration monthStart originalMonthStart originalDuration approvalStatus status approvedDate appliedDate')
                    .lean()
                    .maxTimeMS(12000)
                : [],
            codes.length
                ? Fine.find({
                    fineStatus: { $in: APPROVED_FINE_STATUSES },
                    sourceOfIncome: { $ne: 'End of Service' },
                    'assignedEmployees.employeeId': { $in: codes },
                })
                    .select('assignedEmployees employeeAmount companyAmount serviceCharge discount totalFineAmount fineAmount fineStatus sourceOfIncome payableDuration monthStart originalMonthStart originalPayableDuration responsibleFor awardedDate createdAt')
                    .lean()
                    .maxTimeMS(12000)
                : [],
        ]);

        for (const loan of loans || []) {
            const code = String(loan.employeeId || '').trim();
            if (!empByCode.has(code)) continue;
            const installments = buildLoanInstallments({
                ...loan,
                monthStart: loan.originalMonthStart || loan.monthStart || toYearMonth(loan.approvedDate || loan.appliedDate),
                duration: loan.originalDuration ?? loan.duration,
            });
            for (const part of installments) {
                const ym = String(part.monthKey || '');
                if (!/^\d{4}-\d{2}$/.test(ym)) continue;
                addDeduction(code, ym, money(part.amount));
            }
        }

        for (const fine of fines || []) {
            const duration = Math.max(1, Number(fine.originalPayableDuration ?? fine.payableDuration) || 1);
            const startFineYm = toYearMonth(fine.originalMonthStart || fine.monthStart || fine.awardedDate || fine.createdAt);
            const scheduled = scheduleMonths(startFineYm, duration);
            for (const ym of scheduled) {
                for (const assignee of fine.assignedEmployees || []) {
                    const code = String(assignee?.employeeId || '').trim();
                    if (!empByCode.has(code)) continue;
                    const payable = resolveEmployeeFinePayableAmount(fine, code);
                    if (payable <= 0) continue;
                    addDeduction(code, ym, payable / duration);
                }
            }
        }

        function codesEnrolledInMonth(ym) {
            const codesForMonth = [];
            const seen = new Set();
            for (const row of enrollments) {
                const code = String(row.employeeId || '').trim();
                if (!code || seen.has(code) || !row.fromMonth || row.fromMonth > ym) continue;
                const emp = empByCode.get(code);
                if (emp && !employeeWorkedInMonth(emp, ym)) continue;
                seen.add(code);
                codesForMonth.push(code);
            }
            return codesForMonth;
        }

        const employeesForMonth = [];
        const monthPayments = detailYm ? await listMonthPayments(detailYm) : [];
        const processedEmployeeIds = new Set(
            monthPayments.flatMap((row) => row.selectedIds || []),
        );
        const months = [...monthKeys].reverse().map((ym, index) => {
            const monthCodes = codesEnrolledInMonth(ym);
            let monthlySalary = 0;
            let basicSalary = 0;
            let ot = 0;
            let deduction = 0;
            for (const code of monthCodes) {
                const emp = empByCode.get(code);
                const salaryDoc = salaryByCode.get(code);
                const empMonthly = salaryAmountForMonth(salaryDoc, ym);
                const empBasic = basicAmountForMonth(salaryDoc, ym);
                const empOt = otByKey.get(`${code}|${ym}`) || 0;
                const empDeduction = deductionByKey.get(`${code}|${ym}`) || 0;
                monthlySalary += empMonthly;
                basicSalary += empBasic;
                ot += empOt;
                deduction += empDeduction;
                if (detailYm && ym === detailYm) {
                    employeesForMonth.push({
                        slNo: employeesForMonth.length + 1,
                        employeeId: code,
                        name: emp
                            ? `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || code
                            : code,
                        companyName: companyDisplayName(emp?.company) || '—',
                        staffType: normalizeStaffTypeKey(emp?.staffType),
                        monthlySalary: roundMoney(empMonthly),
                        actualSalary: roundMoney(Math.max(0, empMonthly + empOt - empDeduction)),
                        basicSalary: roundMoney(empBasic),
                        ot: roundMoney(empOt),
                        deduction: roundMoney(empDeduction),
                        paymentType: paymentTypeFromBank(bankByCode.get(code)),
                        status: processedEmployeeIds.has(code)
                            ? 'Processed'
                            : pendingEmployeeIds.has(code)
                              ? 'Pending'
                              : 'Ready',
                    });
                }
            }
            monthlySalary = roundMoney(monthlySalary);
            basicSalary = roundMoney(basicSalary);
            ot = roundMoney(ot);
            deduction = roundMoney(deduction);
            return {
                slNo: index + 1,
                monthKey: ym,
                month: monthRowLabel(ym),
                enrollUser: monthCodes.length,
                monthlySalary,
                actualSalary: roundMoney(Math.max(0, monthlySalary + ot - deduction)),
                basicSalary,
                ot,
                deduction,
            };
        });

        let visibleMonths = months
            .filter((row) => !hiddenMonths.has(row.monthKey))
            .map((row, index) => ({ ...row, slNo: index + 1 }));

        const enrolledUsers = buildEnrolledUserRows(enrollments, {
            employees,
            salaryByCode,
            otByKey,
            deductionByKey,
            salaryYm: endYm,
        });

        return res.status(200).json({
            fromMonth: startYm,
            toMonth: endYm,
            month: detailYm ? monthLabel(detailYm) : null,
            monthKey: detailYm || null,
            months: visibleMonths,
            enrolledUsers,
            employees: detailYm ? employeesForMonth : undefined,
            payments: detailYm ? monthPayments : undefined,
            ...registerMeta,
            waitingForProcessingDate: Boolean(processDay && todayDay < processDay && endYm < currentYm),
            enrollmentOverview,
        });
    } catch (error) {
        console.error('[getSalaryRegister]', error);
        return res.status(500).json({
            message: error.message || 'Failed to load salary register.',
        });
    }
};

function isSalaryAdmin(req) {
    const user = req?.user;
    if (!user) return false;
    if (isJwtSystemSuperUser(user)) return true;
    return user.isAdmin === true || user.isAdministrator === true;
}

/**
 * DELETE /api/Employee/salary-register/:monthKey
 * Admin / super user only. Hides that month row from the salary list.
 */
export const deleteSalaryRegisterMonth = async (req, res) => {
    try {
        if (!isSalaryAdmin(req)) {
            return res.status(403).json({ message: 'Only admin super user can delete a salary month.' });
        }
        const monthKey = toYearMonth(req.params.monthKey);
        if (!monthKey) {
            return res.status(400).json({ message: 'Invalid salary month.' });
        }
        await PayrollSettings.findOneAndUpdate(
            { key: 'default' },
            { $addToSet: { hiddenSalaryMonths: monthKey } },
            { upsert: true, setDefaultsOnInsert: true },
        );
        return res.status(200).json({ message: 'Salary month removed.', monthKey });
    } catch (error) {
        console.error('[deleteSalaryRegisterMonth]', error);
        return res.status(500).json({ message: error.message || 'Failed to delete salary month.' });
    }
};

/**
 * POST /api/Employee/salary-register/restore
 * Admin / super user only. Puts hidden months back on the salary list.
 * Body: { monthKey } to restore one month, or omit to restore all.
 */
export const restoreSalaryRegisterMonths = async (req, res) => {
    try {
        if (!isSalaryAdmin(req)) {
            return res.status(403).json({ message: 'Only admin super user can add a salary month.' });
        }
        const monthKey = toYearMonth(req.body?.monthKey || req.query?.monthKey);
        const update = monthKey
            ? { $pull: { hiddenSalaryMonths: monthKey } }
            : { $set: { hiddenSalaryMonths: [] } };
        await PayrollSettings.findOneAndUpdate(
            { key: 'default' },
            update,
            { upsert: true, setDefaultsOnInsert: true },
        );
        return res.status(200).json({
            message: monthKey ? 'Salary month added.' : 'Salary months added.',
            monthKey: monthKey || null,
        });
    } catch (error) {
        console.error('[restoreSalaryRegisterMonths]', error);
        return res.status(500).json({ message: error.message || 'Failed to add salary month.' });
    }
};

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * POST /api/Employee/salary-register/:monthKey/blockers/remind
 * One email per employee (company profile email) listing every pending payroll item.
 */
export const sendPayrollBlockerReminders = async (req, res) => {
    try {
        const monthKey = toYearMonth(req.params.monthKey || req.body?.monthKey);
        if (!monthKey) {
            return res.status(400).json({ message: 'Invalid salary month.' });
        }

        const employeeRows = await EmployeeBasic.find({
            employeeId: { $nin: ['', 'VEGA-HR-0000'] },
            status: { $ne: 'Left User' },
            profileStatus: 'active',
            ...REAL_EMPLOYEE_MONGO_FILTER,
        })
            .select('employeeId firstName lastName staffType companyEmail')
            .lean()
            .maxTimeMS(12000);

        const people = (employeeRows || []).filter((emp) => {
            const code = String(emp?.employeeId || '').trim();
            return Boolean(code && !isPlaceholderEmployeeId(code) && !isCompanyShellEmployee(emp));
        });

        const items = await buildGroupPendingRequests(people, monthKey);
        const byEmployee = new Map();
        for (const item of items) {
            const code = String(item.employeeId || '').trim();
            if (!code) continue;
            if (!byEmployee.has(code)) {
                byEmployee.set(code, {
                    employeeId: code,
                    name: item.name,
                    tasks: [],
                });
            }
            byEmployee.get(code).tasks.push(item);
        }

        const emailByCode = new Map(
            people.map((emp) => [
                String(emp.employeeId || '').trim(),
                String(emp.companyEmail || '').trim().toLowerCase(),
            ]),
        );

        const label = monthLabel(monthKey);
        let sent = 0;
        let skipped = 0;

        for (const row of byEmployee.values()) {
            const to = emailByCode.get(row.employeeId) || '';
            if (!to) {
                skipped += 1;
                continue;
            }
            const taskLines = row.tasks
                .map((task) => {
                    const extra = String(task.detail || '').trim();
                    return `<li><strong>${escapeHtml(task.title)}</strong>${
                        extra ? ` — ${escapeHtml(extra)}` : ''
                    }</li>`;
                })
                .join('');
            sendMailLater({
                to,
                subject: `Payroll pending items — ${label}`,
                html: `
                    <p>Hello ${escapeHtml(row.name)},</p>
                    <p>You have <strong>${row.tasks.length}</strong> pending payroll item${
                        row.tasks.length === 1 ? '' : 's'
                    } for <strong>${escapeHtml(label)}</strong>.</p>
                    <ul>${taskLines}</ul>
                    <p>Please complete these items so payroll can proceed. This is the only reminder for all of your pending items.</p>
                `,
            });
            sent += 1;
        }

        return res.status(200).json({
            sent,
            skipped,
            employees: byEmployee.size,
            items: items.length,
            monthKey,
        });
    } catch (error) {
        console.error('[sendPayrollBlockerReminders]', error);
        return res.status(500).json({ message: error.message || 'Failed to send payroll reminders.' });
    }
};

/**
 * POST /api/Employee/salary-register/:monthKey/payments
 * Persist a processed payment card for this salary month.
 */
export const createSalaryMonthPayment = async (req, res) => {
    try {
        const monthKey = toYearMonth(req.params.monthKey || req.body?.monthKey);
        if (!monthKey) {
            return res.status(400).json({ message: 'Invalid salary month.' });
        }

        const rawIds = Array.isArray(req.body?.employeeIds)
            ? req.body.employeeIds
            : Array.isArray(req.body?.selectedIds)
              ? req.body.selectedIds
              : [];
        const requested = [
            ...new Set(rawIds.map((id) => String(id || '').trim()).filter(Boolean)),
        ];
        if (!requested.length) {
            return res.status(400).json({ message: 'Select at least one employee.' });
        }

        const existing = await SalaryMonthPayment.find({ monthKey })
            .select('employeeIds paymentNo')
            .lean()
            .maxTimeMS(8000);
        const claimed = new Set();
        let lastNo = 0;
        for (const row of existing || []) {
            lastNo = Math.max(lastNo, Number(row.paymentNo) || 0);
            for (const id of row.employeeIds || []) {
                const code = String(id || '').trim();
                if (code) claimed.add(code);
            }
        }

        const alreadyClaimed = requested.filter((id) => claimed.has(id));
        if (alreadyClaimed.length) {
            return res.status(409).json({
                message: 'One or more employees are already in another payment for this month.',
                employeeIds: alreadyClaimed,
            });
        }

        const enrolled = await SalaryEnrollment.find({
            employeeId: { $in: requested },
            fromMonth: { $lte: monthKey },
        })
            .select('employeeId')
            .lean()
            .maxTimeMS(8000);
        const enrolledIds = new Set(
            (enrolled || []).map((row) => String(row.employeeId || '').trim()).filter(Boolean),
        );
        const employeeIds = requested.filter((id) => enrolledIds.has(id));
        if (!employeeIds.length) {
            return res.status(400).json({ message: 'Only enrolled employees can be added to a payment.' });
        }

        const createdByRaw = req.user?.id || req.user?._id;
        const createdBy =
            createdByRaw && mongoose.Types.ObjectId.isValid(createdByRaw) ? createdByRaw : null;

        const doc = await SalaryMonthPayment.create({
            monthKey,
            paymentNo: lastNo + 1,
            employeeIds,
            createdBy,
        });

        return res.status(201).json({
            message: 'Payment saved.',
            payment: serializeMonthPayment(doc),
        });
    } catch (error) {
        if (error?.code === 11000) {
            return res.status(409).json({ message: 'Payment number already used. Try again.' });
        }
        console.error('[createSalaryMonthPayment]', error);
        return res.status(500).json({ message: error.message || 'Failed to save payment.' });
    }
};
