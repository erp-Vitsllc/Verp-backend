import mongoose from 'mongoose';
import Attendance from '../../models/Attendance.js';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import EmployeeSalary from '../../models/EmployeeSalary.js';
import SalaryEnrollment from '../../models/SalaryEnrollment.js';
import SalaryHistoricalProfile from '../../models/SalaryHistoricalProfile.js';
import SalaryMonthPayment from '../../models/SalaryMonthPayment.js';
import SalaryMonthDmf from '../../models/SalaryMonthDmf.js';
import PayrollSettings from '../../models/PayrollSettings.js';
import Company from '../../models/Company.js';
import Fine from '../../models/Fine.js';
import Loan from '../../models/Loan.js';
import AssetItem from '../../models/AssetItem.js';
import UtilityBillPayment from '../../models/UtilityBillPayment.js';
import UtilityEntry from '../../models/UtilityEntry.js';
import PartyExpense from '../../models/PartyExpense.js';
import EmployeeHubRequest from '../../models/EmployeeHubRequest.js';
import AttendanceChangeRequest from '../../models/AttendanceChangeRequest.js';
import DashboardAction from '../../models/DashboardAction.js';
import User from '../../models/User.js';
import { ATTENDANCE_CHANGE_OPEN_STAGES } from '../../utils/attendanceChangeApproval.js';
import { buildSalaryPreparationPending } from '../../utils/salaryPreparationPending.js';
import { leaveDashboardRequestObjectId } from '../../utils/notifyLeaveDashboardRequest.js';
import {
    PAYROLL_FINE_QUERY_STATUSES,
    PAYROLL_LOAN_QUERY_STATUSES,
    assetPayrollInvolvement,
    assetTaskPath,
    fineBlocksThisPayrollMonth,
    finePayrollRole,
    finePayrollTitle,
    loanBlocksPayrollReady,
    loanPayrollRole,
    loanPayrollTitle,
    partyBalanceDueInMonth,
    utilityBillPath,
    utilityBillPending,
    utilityExcessForMonth,
    utilityPayeeCodes,
    utilityPendingRole,
} from '../../utils/payrollReadyRules.js';
import { unsettledCompOffMessage } from '../../utils/compOffSettlement.js';
import { getDepartmentHOD } from '../../utils/getDepartmentHOD.js';
import { getManagementHOD } from '../../utils/getManagementHOD.js';
import {
    isCompanyShellEmployee,
    REAL_EMPLOYEE_MONGO_FILTER,
} from '../../utils/attendanceEmployeeFilters.js';
import { isPlaceholderEmployeeId } from '../../utils/employeeIdPrefix.js';
import {
    listActiveWorkLocations,
    normalizeStaffTypeKey,
} from '../../utils/workLocationHelpers.js';
import { serializePayrollSettings, reminderAudienceList } from './payrollSettingsController.js';
import {
    lateInOutSummary,
    missedPunchDeduction,
} from '../../utils/lateDeductionPolicy.js';
import { partialLeavePortion } from '../../utils/partialLeaveWindow.js';
import { explicitAuthorizedHourShare, isDeductionWaived, isHourLossWaived } from '../../utils/deductionWaive.js';
import {
    keepAttendanceForProcessingStart,
    processingStartFromEnrollment,
    resolveSalaryProcessingStartDate,
} from '../../utils/leaveSalaryVisibility.js';
import { resolveEmployeeFinePayableAmount } from '../../utils/finePayableAmount.js';
import { collectSalarySlipPayrollFigures } from '../../utils/buildSalarySlipPayload.js';
import { buildLoanInstallments } from '../../utils/upsertLoanPartyExpenseFromPayment.js';
import {
    getScheduledEmailTimeZone,
    getZonedParts,
} from '../../utils/scheduleDailyAtMidnight.js';
import {
    enrollmentCoversSalaryMonth,
    lastOpenSalaryProcessMonth,
    salaryRegisterPayrollOpenMonth,
} from '../../utils/salaryEnrollmentStartMonth.js';
import { viewerIsFlowchartHrAssignee, viewerIsSalaryFlowchartHr } from '../../utils/viewerIsSalaryFlowchartHr.js';
import {
    buildDmfViewerContext,
    monthPayrollProcessStatusLabel,
    serializeDmf,
} from '../../utils/salaryDmfApproval.js';
import { resolveFlowchartHrEmployee } from '../../utils/resolveFlowchartHrEmployee.js';
import { salaryMonthPaymentLabel, slotHoldsEmployees, slotStatusOf, singleSlotPayType } from '../../utils/salarySlotRules.js';
import {
    closeAccountsSalarySlotInbox,
    notifyAccountsSalarySlot,
    notifyHrSalarySlot,
    sendSalarySlotMail,
} from '../../utils/salaryDmfNotify.js';
import { sendMailLater } from '../../utils/salaryEnrollmentApprovalNotify.js';
import { buildSlotAccountsEmailHtml, buildSlotHrApprovalEmailHtml, payrollMonthLabel } from '../../utils/payrollApprovalMail.js';
import { buildSalarySlotFile } from '../../utils/salarySlotWorkbook.js';
import { withFrontendPath } from '../../utils/resolveFrontendBaseUrl.js';
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

function money(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

function employeeCodeKey(value) {
    return String(value || '').trim().replace(/\s+/g, '').toUpperCase();
}

function getByEmployeeCode(map, id) {
    if (!map) return undefined;
    const key = employeeCodeKey(id);
    return key ? map.get(key) : undefined;
}

function companyRefId(value) {
    if (value == null || value === '') return '';
    if (typeof value === 'object') {
        if (value._id) return String(value._id).trim();
        if (typeof value.toHexString === 'function') return value.toHexString();
    }
    return String(value).trim();
}

function isDirectorySalaryEmployee(emp) {
    if (!emp || isCompanyShellEmployee(emp) || isPlaceholderEmployeeId(emp.employeeId)) return false;
    return String(emp.status || '') !== 'Left User';
}

function isActiveSalaryEmployee(emp) {
    if (!isDirectorySalaryEmployee(emp)) return false;
    const profile = String(emp.profileStatus || '').trim().toLowerCase();
    return profile === 'active' || profile === '';
}

function normalizeEnrollmentRows(rows) {
    const byKey = new Map();
    for (const row of rows || []) {
        const raw = typeof row === 'string' ? { employeeId: row } : row;
        const employeeId = String(raw?.employeeId || '').trim();
        const key = employeeCodeKey(employeeId);
        if (!key) continue;
        const fromMonth = enrollmentFromMonth(raw);
        const prev = byKey.get(key);
        if (!prev) {
            byKey.set(key, {
                employeeId,
                fromMonth: fromMonth || '',
                salaryDate: raw.salaryDate,
                processDate: raw.processDate,
            });
            continue;
        }
        if (!prev.fromMonth && fromMonth) {
            byKey.set(key, {
                ...prev,
                fromMonth,
                salaryDate: prev.salaryDate ?? raw.salaryDate,
                processDate: prev.processDate ?? raw.processDate,
            });
            continue;
        }
        if (fromMonth && prev.fromMonth && fromMonth < prev.fromMonth) {
            byKey.set(key, { ...prev, fromMonth });
        }
    }
    return byKey;
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
        (employees || []).map((emp) => [employeeCodeKey(emp.employeeId), emp]),
    );
    const rows = [];
    const seen = new Set();
    for (const row of enrollments || []) {
        const key = employeeCodeKey(row.employeeId);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const emp = empByCode.get(key);
        if (!emp) continue;
        const code = String(emp.employeeId || row.employeeId || '').trim();
        const name = `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || code;
        const from = row.fromMonth;
        const ym = salaryYm && from && from <= salaryYm ? salaryYm : from;
        const salaryDoc = getByEmployeeCode(salaryByCode, code);
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
    const keySet = new Set(enrollments.map((row) => employeeCodeKey(row.employeeId)).filter(Boolean));
    if (!keySet.size) return [];
    const [directoryRows, salaryDocs] = await Promise.all([
        EmployeeBasic.find({
            employeeId: { $nin: ['', 'VEGA-HR-0000'] },
            ...REAL_EMPLOYEE_MONGO_FILTER,
        })
            .select('employeeId firstName lastName')
            .lean()
            .maxTimeMS(8000),
        EmployeeSalary.find({ employeeId: { $in: enrollments.map((row) => row.employeeId).filter(Boolean) } })
            .select('-offerLetter.data -salaryHistory.attachment.data -salaryHistory.offerLetter.data')
            .lean()
            .maxTimeMS(8000),
    ]);
    const employees = (directoryRows || []).filter(
        (emp) => keySet.has(employeeCodeKey(emp.employeeId)) && !isCompanyShellEmployee(emp),
    );
    const salaryByCode = new Map(
        (salaryDocs || []).map((doc) => [employeeCodeKey(doc.employeeId), doc]),
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

function waitingLabel(fromDate) {
    const date = fromDate instanceof Date ? fromDate : fromDate ? new Date(fromDate) : null;
    if (!date || Number.isNaN(date.getTime())) return '—';
    const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const now = new Date();
    const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    const days = Math.round((today - start) / 86400000);
    if (!Number.isFinite(days) || days < 0) return '—';
    if (days <= 0) return 'Today';
    if (days === 1) return '1 day';
    return `${days} days`;
}

function roleForPendingStatus(status) {
    const value = String(status || '').toLowerCase();
    if (value.includes('account') || value.includes('finance')) return 'Accounts';
    if (value.includes('authoriz') || value.includes('management')) return 'Management';
    if (value.includes('hr') || value.includes('review')) return 'HR';
    return '';
}

function displayEmployeeName(emp) {
    if (!emp) return '';
    return `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || String(emp.employeeId || '').trim();
}

function isRoleLabel(value) {
    const v = String(value || '').trim().toLowerCase();
    if (!v || v === '—') return true;
    return /^(hr|hod|management|accounts|approver|employee|manager|admin|admin \/ hr|department hod)$/i.test(v);
}

async function hodForRole(role, cache) {
    const key = String(role || '').trim();
    if (!key) return null;
    if (cache.has(key)) return cache.get(key);
    let hod = null;
    if (key === 'HR') hod = await getDepartmentHOD('hr');
    else if (key === 'Accounts') hod = await getDepartmentHOD('accounts');
    else if (key === 'Management') hod = await getManagementHOD();
    cache.set(key, hod || null);
    return hod || null;
}

function toObjectIdList(ids) {
    const unique = [...new Set((ids || []).map((id) => String(id || '').trim()).filter(Boolean))];
    return unique.filter((id) => mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(id));
}

async function loadAssigneePeople({ empIds = [], mongoIds = [] }) {
    const codes = [...new Set((empIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    const objectIds = toObjectIdList(mongoIds);
    const [empsByCode, empsByMongo, users] = await Promise.all([
        codes.length
            ? EmployeeBasic.find({ employeeId: { $in: codes } })
                .select('employeeId firstName lastName email companyEmail')
                .lean()
                .maxTimeMS(8000)
            : [],
        objectIds.length
            ? EmployeeBasic.find({ _id: { $in: objectIds } })
                .select('employeeId firstName lastName email companyEmail')
                .lean()
                .maxTimeMS(8000)
            : [],
        objectIds.length
            ? User.find({ _id: { $in: objectIds } })
                .select('employeeId name email')
                .lean()
                .maxTimeMS(8000)
            : [],
    ]);
    const byEmpId = new Map();
    const byMongo = new Map();
    for (const emp of [...(empsByCode || []), ...(empsByMongo || [])]) {
        const code = String(emp.employeeId || '').trim();
        if (code) byEmpId.set(code, emp);
        byMongo.set(String(emp._id), emp);
    }
    const userEmpCodes = [...new Set((users || []).map((row) => String(row.employeeId || '').trim()).filter(Boolean))];
    const extra = userEmpCodes.length
        ? await EmployeeBasic.find({ employeeId: { $in: userEmpCodes } })
            .select('employeeId firstName lastName email companyEmail')
            .lean()
            .maxTimeMS(8000)
        : [];
    for (const emp of extra || []) {
        const code = String(emp.employeeId || '').trim();
        if (code) byEmpId.set(code, emp);
        byMongo.set(String(emp._id), emp);
    }
    const userByMongo = new Map((users || []).map((row) => [String(row._id), row]));
    return { byEmpId, byMongo, userByMongo };
}

function personFromMaps(code, mongoId, maps) {
    const empId = String(code || '').trim();
    const oid = String(mongoId || '').trim();
    const emp =
        (empId && maps.byEmpId.get(empId)) ||
        (oid && maps.byMongo.get(oid)) ||
        null;
    if (emp) {
        return {
            employeeId: String(emp.employeeId || empId).trim(),
            name: displayEmployeeName(emp),
        };
    }
    const user = oid ? maps.userByMongo.get(oid) : null;
    if (user) {
        const userCode = String(user.employeeId || '').trim();
        const linked = userCode ? maps.byEmpId.get(userCode) : null;
        if (linked) {
            return { employeeId: String(linked.employeeId || '').trim(), name: displayEmployeeName(linked) };
        }
        return { employeeId: userCode, name: String(user.name || '').trim() };
    }
    return { employeeId: empId, name: '' };
}

async function attachPayrollBlockerAssignees(items) {
    const rows = Array.isArray(items) ? items : [];
    if (!rows.length) return rows;

    try {
        const requestIds = toObjectIdList(rows.map((item) => item.requestId));
        const actions = requestIds.length
            ? await DashboardAction.find({
                status: 'Pending',
                requestId: { $in: requestIds },
            })
                .select('requestId assignedTo assignedToEmpId requestedDate createdAt updatedAt')
                .lean()
                .maxTimeMS(8000)
            : [];

        const actionByRequest = new Map();
        for (const action of actions || []) {
            const key = String(action.requestId || '');
            if (!key) continue;
            const prev = actionByRequest.get(key);
            const nextTime = new Date(action.updatedAt || action.requestedDate || 0).getTime();
            const prevTime = prev ? new Date(prev.updatedAt || prev.requestedDate || 0).getTime() : 0;
            if (!prev || nextTime >= prevTime) actionByRequest.set(key, action);
        }

        const empIds = [];
        const mongoIds = [];
        for (const item of rows) {
            if (item.responsibleId) empIds.push(item.responsibleId);
            if (item.assigneeMongoId) mongoIds.push(item.assigneeMongoId);
        }
        for (const action of actionByRequest.values()) {
            if (action.assignedToEmpId) empIds.push(action.assignedToEmpId);
            if (action.assignedTo) mongoIds.push(action.assignedTo);
        }

        const maps = await loadAssigneePeople({ empIds, mongoIds });
        const hodCache = new Map();

        for (const item of rows) {
            const action = actionByRequest.get(String(item.requestId || ''));
            let responsibleId = String(item.responsibleId || '').trim();
            let responsibleName = String(item.responsibleName || '').trim();
            let responsibleRole =
                String(item.responsibleRole || '').trim() ||
                roleForPendingStatus(item.detail) ||
                (String(item.id || '').startsWith('unmarked-') ? 'Employee' : item.category === 'finance' ? 'HR' : 'Approver');
            let notifiedAt = item.notifiedAt || action?.requestedDate || action?.createdAt || item.dateKey || '';

            const tryAssign = (code, mongoId) => {
                const person = personFromMaps(code, mongoId, maps);
                if (person.employeeId && !responsibleId) responsibleId = person.employeeId;
                if (person.name && !responsibleName) responsibleName = person.name;
            };

            if (action) {
                tryAssign(action.assignedToEmpId, action.assignedTo);
                notifiedAt = action.requestedDate || action.createdAt || notifiedAt;
            }
            tryAssign(item.responsibleId, item.assigneeMongoId);

            if (isRoleLabel(responsibleName)) responsibleName = '';

            if (!responsibleName) {
                if (String(item.id || '').startsWith('unmarked-')) {
                    responsibleId = responsibleId || item.employeeId;
                    responsibleName = responsibleName || item.name;
                    responsibleRole = 'Employee';
                } else {
                    const hod = await hodForRole(responsibleRole === 'Approver' ? 'HR' : responsibleRole, hodCache);
                    if (hod) {
                        const code = String(hod.employeeId || '').trim();
                        if (code) {
                            maps.byEmpId.set(code, hod);
                            maps.byMongo.set(String(hod._id), hod);
                            tryAssign(code, hod._id);
                        }
                        if (!responsibleName) responsibleName = displayEmployeeName(hod);
                        if (!responsibleId) responsibleId = code;
                    }
                }
            }

            if (!responsibleName) responsibleName = responsibleRole || '—';

            item.responsibleId = responsibleId;
            item.responsibleName = responsibleName;
            item.responsibleRole = responsibleRole;
            const parsedNotify = notifiedAt ? new Date(notifiedAt) : null;
            item.notifiedAt = parsedNotify && !Number.isNaN(parsedNotify.getTime()) ? parsedNotify.toISOString() : '';
            item.waitingLabel = waitingLabel(item.notifiedAt || notifiedAt);
            item.actorIsSubject = Boolean(responsibleId && responsibleId === item.employeeId);
        }
    } catch (error) {
        console.error('[attachPayrollBlockerAssignees]', error);
        for (const item of rows) {
            const role =
                roleForPendingStatus(item.detail) ||
                (String(item.id || '').startsWith('unmarked-') ? 'Employee' : 'Approver');
            item.responsibleId = item.responsibleId || '';
            item.responsibleName = item.responsibleName || role;
            item.responsibleRole = item.responsibleRole || role;
            item.waitingLabel = item.waitingLabel || waitingLabel(item.notifiedAt || item.dateKey);
        }
    }

    return rows;
}

async function buildGroupPendingRequests(people, monthKey) {
    const rows = Array.isArray(people) ? people : [];
    if (!rows.length) return [];

    const range = monthDateRange(monthKey);
    const empByMongo = new Map(rows.map((emp) => [String(emp._id), emp]));
    const empByCode = new Map(rows.map((emp) => [employeeCodeKey(emp.employeeId), emp]));
    const mongoIds = rows.map((emp) => String(emp._id));
    const objectIds = rows.map((emp) => emp._id).filter(Boolean);
    const codes = rows.map((emp) => String(emp.employeeId || '').trim()).filter(Boolean);

    const monthWindow = range
        ? {
            $or: [
                { date: { $gte: range.from, $lte: range.to } },
                { leaveRequestFromDate: { $gte: range.from, $lte: range.to } },
                { leaveRequestToDate: { $gte: range.from, $lte: range.to } },
                { leaveRequestFromDate: { $lte: range.from }, leaveRequestToDate: { $gte: range.to } },
            ],
        }
        : null;

    const [attendanceRows, changeRows, loans, fines, hubRows, assets, utilityBills, utilityEntries, utilityBalances] =
        await Promise.all([
            mongoIds.length
                ? Attendance.find({
                    employeeMongoId: { $in: mongoIds },
                    ...(monthWindow ? { $and: [monthWindow] } : {}),
                    $or: [
                        { leaveRequestStatus: 'pending' },
                        { hourAdjustStatus: 'pending' },
                        { flexibleOtStatus: 'pending' },
                    ],
                })
                    .select(
                        '_id employeeMongoId employeeId employeeName date leaveRequestKind requestedStatusKey requestedStatusLabel leaveRequestGroupId leaveRequestFromDate leaveRequestToDate leaveRequestedAt leaveApprovalStage approvalStatus hourAdjustStatus hoursApproved flexibleOtStatus flexibleOtApprovedHours createdAt',
                    )
                    .lean()
                    .maxTimeMS(12000)
                : [],
            mongoIds.length
                ? AttendanceChangeRequest.find({
                    employeeMongoId: { $in: mongoIds },
                    stage: { $in: ATTENDANCE_CHANGE_OPEN_STAGES },
                    ...(range ? { date: { $gte: range.from, $lte: range.to } } : {}),
                })
                    .select(
                        'date employeeMongoId stage action proposed previous requestedByName reporteeId reporteeName hrId hrName staffType createdAt',
                    )
                    .lean()
                    .maxTimeMS(8000)
                : [],
            codes.length
                ? Loan.find({
                    employeeId: { $in: codes },
                    $or: [
                        { status: { $in: PAYROLL_LOAN_QUERY_STATUSES } },
                        { approvalStatus: { $in: PAYROLL_LOAN_QUERY_STATUSES } },
                    ],
                })
                    .select('_id employeeId type status approvalStatus amount paidAmount workflow submittedTo createdAt updatedAt')
                    .lean()
                    .maxTimeMS(8000)
                : [],
            codes.length
                ? Fine.find({
                    fineStatus: { $in: PAYROLL_FINE_QUERY_STATUSES },
                    'assignedEmployees.employeeId': { $in: codes },
                })
                    .select(
                        '_id fineId fineStatus fineType assignedEmployees workflow accountsPaymentPath zohoBillId zohoBillNumber zohoJournalId zohoJournalNumber vendorBillStatus awardedDate createdAt updatedAt',
                    )
                    .lean()
                    .maxTimeMS(8000)
                : [],
            objectIds.length
                ? EmployeeHubRequest.find({
                    status: 'Pending',
                    $or: [{ requester: { $in: objectIds } }, { requesterEmpId: { $in: codes } }],
                })
                    .select('_id kind requester requesterEmpId requesterName assignedTo assignedToEmpId createdAt')
                    .lean()
                    .maxTimeMS(8000)
                    .catch(() => [])
                : [],
            objectIds.length
                ? AssetItem.find({
                    $or: [
                        { assignedTo: { $in: objectIds }, acceptanceStatus: 'Pending' },
                        {
                            pendingAction: 'Return Asset',
                            $or: [
                                { assignedTo: { $in: objectIds } },
                                { actionRequiredBy: { $in: objectIds } },
                                { 'pendingActionDetails.requestedBy': { $in: [...objectIds, ...mongoIds] } },
                            ],
                        },
                    ],
                })
                    .select(
                        '_id assetId name plateNumber vehicleCode pendingAction acceptanceStatus assignedTo assignedBy actionRequiredBy pendingActionDetails',
                    )
                    .lean()
                    .maxTimeMS(8000)
                : [],
            codes.length
                ? UtilityBillPayment.find({
                    status: { $in: ['Pending Accounts', 'Pending HR', 'Approved', 'Paid'] },
                    $or: [
                        { payByEmployeeId: { $in: codes } },
                        { 'zohoLineItems.payByEmployeeId': { $in: codes } },
                    ],
                })
                    .select(
                        '_id entryId utilityType billMonth status paymentBy payByEmployeeId pendingWithName pendingWithRole employeeDiffAmount zohoLineItems createdAt updatedAt',
                    )
                    .lean()
                    .maxTimeMS(8000)
                : [],
            codes.length
                ? UtilityEntry.find({
                    assignedToType: 'Employee',
                    assignedToId: { $in: codes },
                    pendingStatusChange: { $ne: null },
                })
                    .select('_id type assignedToId pendingStatusChange updatedAt createdAt')
                    .lean()
                    .maxTimeMS(8000)
                : [],
            codes.length
                ? PartyExpense.find({
                    partyType: 'employee',
                    kind: 'balance',
                    employeeId: { $in: codes },
                    status: 'Not Paid',
                })
                    .select('employeeId status kind amount billMonth installments utilityBillId utilityType accountNo')
                    .lean()
                    .maxTimeMS(8000)
                : [],
        ]);

    const items = [];
    const seenUtilityBills = new Set();

    const pushItem = (emp, payload) => {
        if (!emp) return;
        items.push({
            employeeId: String(emp.employeeId || '').trim(),
            mongoId: String(emp._id),
            name: `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || emp.employeeId,
            staffType: normalizeStaffTypeKey(emp.staffType),
            monthKey: monthKey || '',
            ...payload,
        });
    };

    const attendanceByEmp = new Map();
    for (const row of attendanceRows || []) {
        const key = String(row.employeeMongoId || '');
        if (!key) continue;
        if (!attendanceByEmp.has(key)) attendanceByEmp.set(key, []);
        attendanceByEmp.get(key).push(row);
    }
    const changesByEmp = new Map();
    for (const row of changeRows || []) {
        const key = String(row.employeeMongoId || '');
        if (!key) continue;
        if (!changesByEmp.has(key)) changesByEmp.set(key, []);
        changesByEmp.get(key).push(row);
    }

    for (const mongoKey of new Set([...attendanceByEmp.keys(), ...changesByEmp.keys()])) {
        const emp = empByMongo.get(mongoKey);
        if (!emp) continue;
        const empRows = attendanceByEmp.get(mongoKey) || [];
        const empChanges = changesByEmp.get(mongoKey) || [];
        const prep = buildSalaryPreparationPending({
            attendanceRows: empRows,
            changeRows: empChanges,
            staffType: normalizeStaffTypeKey(emp.staffType),
            yearFrom: range?.from || '',
            yearTo: range?.to || '',
            todayKey: range?.to || '',
        });
        const leaveByGroup = new Map();
        for (const row of empRows) {
            if (String(row.leaveRequestStatus || '') !== 'pending') continue;
            const groupId =
                String(row.leaveRequestGroupId || '').trim() ||
                `${row.date}-${String(row.leaveRequestKind || '')}`;
            if (!leaveByGroup.has(groupId)) leaveByGroup.set(groupId, row);
        }
        const changeById = new Map(empChanges.map((row) => [String(row._id), row]));

        for (const item of prep) {
            const appliedKey = String(item.appliedKey || '');
            let category = 'attendance';
            if (appliedKey === 'compoff_leave') category = 'compoff';
            else if (appliedKey === 'flexible_ot') category = 'overtime';
            else if (['on_leave', 'sick_leave', 'authorized_leave', 'unauthorized_leave'].includes(appliedKey)) {
                category = 'leave';
            }
            let responsibleRole = 'Approver';
            let assigneeMongoId = '';
            let responsibleId = '';
            let responsibleName = '';
            let requestId = '';
            if (String(item.id || '').startsWith('leave-')) {
                const source = leaveByGroup.get(String(item.id).slice(6));
                const stage = String(source?.leaveApprovalStage || '');
                requestId = source
                    ? String(leaveDashboardRequestObjectId(source.leaveRequestGroupId, source._id))
                    : '';
                if (stage === 'pending_hr') responsibleRole = 'HR';
                else {
                    responsibleRole = 'Manager';
                    assigneeMongoId = String(emp.primaryReportee || '');
                }
            } else if (String(item.id || '').startsWith('change-')) {
                const source = changeById.get(String(item.id).slice(7));
                requestId = String(source?._id || '');
                const stage = String(source?.stage || '');
                if (stage === 'pending_hr') {
                    responsibleRole = 'HR';
                    responsibleName = String(source?.hrName || '').trim();
                    const hrId = String(source?.hrId || '').trim();
                    if (mongoose.isValidObjectId(hrId)) assigneeMongoId = hrId;
                    else responsibleId = hrId;
                } else if (stage === 'pending_requester') {
                    responsibleRole = 'Employee';
                    responsibleId = String(emp.employeeId || '');
                    responsibleName = `${emp.firstName || ''} ${emp.lastName || ''}`.trim();
                } else {
                    responsibleRole = 'Manager';
                    responsibleName = String(source?.reporteeName || '').trim();
                    const reporteeId = String(source?.reporteeId || '').trim();
                    if (mongoose.isValidObjectId(reporteeId)) assigneeMongoId = reporteeId;
                    else responsibleId = reporteeId || String(emp.primaryReportee || '');
                    if (!assigneeMongoId && !responsibleId) assigneeMongoId = String(emp.primaryReportee || '');
                }
            } else if (appliedKey === 'hour_adjust' || appliedKey === 'flexible_ot') {
                responsibleRole = 'HR';
            }
            pushItem(emp, {
                id: `att-${item.id}`,
                requestId,
                category,
                title: item.title || 'Attendance request',
                detail: item.subtitle || item.fromDate || '',
                dateKey: item.fromDate || item.dateKey || '',
                path: item.href || '',
                notifiedAt: item.dateKey || item.fromDate || '',
                assigneeMongoId,
                responsibleId,
                responsibleName,
                responsibleRole,
            });
        }
    }

    for (const loan of loans || []) {
        if (!loanBlocksPayrollReady(loan)) continue;
        const emp = getByEmployeeCode(empByCode, loan.employeeId);
        const pendingStep = (loan.workflow || []).find((step) => step.status === 'Pending');
        pushItem(emp, {
            id: `loan-${loan._id}`,
            requestId: String(loan._id),
            category: 'finance',
            title: loanPayrollTitle(loan),
            detail: String(loan.approvalStatus || loan.status || 'Pending'),
            dateKey: '',
            path: `/HRM/LoanAndAdvance/${loan._id}`,
            notifiedAt: pendingStep?.assignedAt || loan.updatedAt || loan.createdAt,
            assigneeMongoId: pendingStep?.assignedTo || loan.submittedTo || '',
            responsibleRole: loanPayrollRole(loan),
        });
    }

    for (const fine of fines || []) {
        if (!fineBlocksThisPayrollMonth(fine, monthKey)) continue;
        const assignees = Array.isArray(fine.assignedEmployees) ? fine.assignedEmployees : [];
        const matched = assignees
            .map((row) => getByEmployeeCode(empByCode, row?.employeeId))
            .filter(Boolean);
        for (const emp of matched) {
            const pendingStep = (fine.workflow || []).find((step) => step.status === 'Pending');
            pushItem(emp, {
                id: `fine-${fine._id}-${emp.employeeId}`,
                requestId: String(fine._id),
                fineId: String(fine.fineId || '').trim(),
                isGroup: assignees.filter((row) => String(row?.employeeId || '').trim()).length > 1,
                category: 'finance',
                title: finePayrollTitle(fine),
                detail: String(fine.fineStatus || 'Pending'),
                dateKey: '',
                path: `/HRM/Fine/${fine._id}`,
                notifiedAt: pendingStep?.assignedAt || fine.updatedAt || fine.createdAt,
                assigneeMongoId: pendingStep?.assignedTo || '',
                responsibleRole: finePayrollRole(fine),
            });
        }
    }

    for (const asset of assets || []) {
        const involved = [
            asset.assignedTo,
            asset.assignedBy,
            asset.actionRequiredBy,
            asset.pendingActionDetails?.requestedBy,
        ];
        const seen = new Set();
        for (const ref of involved) {
            const id = ref && typeof ref === 'object' ? String(ref._id || ref) : String(ref || '');
            if (!id || seen.has(id)) continue;
            seen.add(id);
            const hit = assetPayrollInvolvement(asset, id);
            const emp = empByMongo.get(id);
            if (!hit || !emp) continue;
            const assetLabel = [asset.assetId, asset.name].filter(Boolean).join(' · ');
            const onSubject = Boolean(hit.onSubject);
            pushItem(emp, {
                id: `asset-${asset._id}-${emp.employeeId}`,
                requestId: String(asset._id),
                category: 'asset',
                title: hit.title,
                detail: assetLabel,
                dateKey: '',
                path: assetTaskPath(asset),
                notifiedAt: asset.pendingActionDetails?.requestedAt || asset.updatedAt || '',
                assigneeMongoId: onSubject ? '' : hit.assigneeMongoId || '',
                responsibleId: onSubject ? String(emp.employeeId || '') : '',
                responsibleName: onSubject ? `${emp.firstName || ''} ${emp.lastName || ''}`.trim() : '',
                responsibleRole: hit.responsibleRole || 'Approver',
            });
        }
    }

    for (const bill of utilityBills || []) {
        const pending = utilityBillPending(bill);
        const excess = utilityExcessForMonth(bill, monthKey);
        if (!pending && !excess) continue;
        const title = pending ? 'Utility bill pending' : 'Utility excess';
        const role = pending ? utilityPendingRole(bill) : 'Accounts';
        const payeeNames = new Set();
        for (const code of utilityPayeeCodes(bill)) {
            const emp = getByEmployeeCode(empByCode, code);
            if (!emp || payeeNames.has(String(emp.employeeId))) continue;
            if (!pending && excess && employeeCodeKey(code) !== employeeCodeKey(bill.payByEmployeeId)) continue;
            payeeNames.add(String(emp.employeeId));
            seenUtilityBills.add(`${employeeCodeKey(emp.employeeId)}|${String(bill._id)}`);
            pushItem(emp, {
                id: `util-${bill._id}-${emp.employeeId}`,
                requestId: String(bill._id),
                category: 'finance',
                title,
                detail: [bill.utilityType, bill.billMonth].filter(Boolean).join(' · '),
                dateKey: '',
                path: utilityBillPath(bill),
                notifiedAt: bill.updatedAt || bill.createdAt,
                responsibleName: pending ? String(bill.pendingWithName || '').trim() : '',
                responsibleRole: role,
            });
        }
    }

    for (const entry of utilityEntries || []) {
        if (!entry?.pendingStatusChange) continue;
        const emp = getByEmployeeCode(empByCode, entry.assignedToId);
        pushItem(emp, {
            id: `util-entry-${entry._id}`,
            requestId: String(entry._id),
            category: 'finance',
            title: 'Utility account pending',
            detail: String(entry.type || ''),
            dateKey: '',
            path: `/HRM/Asset/UtilityBills/details/${encodeURIComponent(entry._id)}`,
            notifiedAt: entry.updatedAt || entry.createdAt,
            responsibleRole: 'Approver',
        });
    }

    for (const expense of utilityBalances || []) {
        if (!partyBalanceDueInMonth(expense, monthKey)) continue;
        const emp = getByEmployeeCode(empByCode, expense.employeeId);
        if (!emp) continue;
        const billId = String(expense.utilityBillId || '').trim();
        if (billId && seenUtilityBills.has(`${employeeCodeKey(emp.employeeId)}|${billId}`)) continue;
        pushItem(emp, {
            id: `util-balance-${expense._id}-${emp.employeeId}`,
            requestId: billId || String(expense._id),
            category: 'finance',
            title: 'Utility excess',
            detail: [expense.utilityType, expense.billMonth || monthKey].filter(Boolean).join(' · '),
            dateKey: '',
            path: '/HRM/Asset/UtilityBills',
            notifiedAt: '',
            responsibleRole: 'Accounts',
        });
    }

    for (const hub of hubRows || []) {
        const emp =
            empByMongo.get(String(hub.requester || '')) ||
            getByEmployeeCode(empByCode, hub.requesterEmpId);
        const kind = String(hub.kind || '').trim().toLowerCase();
        if (kind === 'assets') continue;
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
            title = 'Early salary request';
        }
        pushItem(emp, {
            id: `hub-${hub._id}`,
            requestId: String(hub._id),
            category,
            title,
            detail: 'Pending approval',
            dateKey: '',
            path: `/dashboard?hubRequestId=${encodeURIComponent(String(hub._id))}`,
            notifiedAt: hub.createdAt,
            responsibleId: String(hub.assignedToEmpId || '').trim(),
            assigneeMongoId: hub.assignedTo || '',
            responsibleRole: kind === 'leave' ? 'Manager' : 'Approver',
        });
    }

    items.sort((a, b) => {
        const dateCmp = String(b.dateKey || '').localeCompare(String(a.dateKey || ''));
        if (dateCmp) return dateCmp;
        return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' });
    });
    return attachPayrollBlockerAssignees(items);
}

async function buildEnrollmentOverview(enrollments, monthKey) {
    const [storedEnrollments, lockedProfiles, companies, employeeRows, locations] = await Promise.all([
        SalaryEnrollment.find({})
            .select('employeeId fromMonth salaryDate processDate')
            .lean()
            .maxTimeMS(8000),
        SalaryHistoricalProfile.find({ workflowStatus: 'locked' })
            .select('employeeId verpStartDate')
            .lean()
            .maxTimeMS(8000),
        Company.find({ status: 'Active' })
            .select('name nickName companyId')
            .sort({ name: 1 })
            .lean()
            .maxTimeMS(8000),
        EmployeeBasic.find({
            employeeId: { $nin: ['', 'VEGA-HR-0000'] },
            status: { $ne: 'Left User' },
            ...REAL_EMPLOYEE_MONGO_FILTER,
        })
            .select('employeeId company lastName firstName staffType designation status profileStatus primaryReportee')
            .lean()
            .maxTimeMS(12000),
        listActiveWorkLocations().catch(() => []),
    ]);
    const storedByKey = normalizeEnrollmentRows(storedEnrollments || []);
    const enrollmentByKey = normalizeEnrollmentRows([
        ...(storedEnrollments || []),
        ...(enrollments || []),
        ...(lockedProfiles || []).map((row) => ({
            employeeId: row.employeeId,
            fromMonth: toYearMonth(row.verpStartDate),
        })),
    ]);

    const people = (employeeRows || []).filter((emp) => {
        if (!isDirectorySalaryEmployee(emp)) return false;
        if (enrollmentByKey.has(employeeCodeKey(emp.employeeId))) return true;
        return isActiveSalaryEmployee(emp);
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
    const codes = people.map((emp) => String(emp.employeeId || '').trim()).filter(Boolean);
    const enrolledCodes = [...enrollmentByKey.values()].map((row) => row.employeeId).filter(Boolean);
    const salaryYm = toYearMonth(monthKey);
    const [salaryDocs, molByCode] = await Promise.all([
        codes.length
            ? EmployeeSalary.find({ employeeId: { $in: codes } })
                .select('-offerLetter.data -salaryHistory.attachment.data -salaryHistory.offerLetter.data')
                .lean()
                .maxTimeMS(15000)
            : Promise.resolve([]),
        companyMolByEmployeeId(enrolledCodes),
    ]);
    const salaryByCode = new Map(
        (salaryDocs || []).map((doc) => [employeeCodeKey(doc.employeeId), doc]),
    );

    let enrolled = 0;
    let enrolledSalary = 0;
    let totalSalary = 0;
    let wpsEnrolled = 0;
    let cashEnrolled = 0;
    const unassigned = { enrolled: 0, totalActive: 0 };
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

    const companyById = new Map();
    const companyCodeToId = new Map();
    const publicCompanyIdByMongo = new Map();
    for (const company of companies || []) {
        const mongoId = String(company._id);
        companyById.set(mongoId, String(company.nickName || company.name || '').trim());
        publicCompanyIdByMongo.set(mongoId, String(company.companyId || company._id));
        const companyCode = String(company.companyId || '').trim().toUpperCase();
        if (companyCode) companyCodeToId.set(companyCode, mongoId);
    }

    function companyStatsKey(emp) {
        const objectId = companyRefId(emp?.company);
        if (objectId && companyById.has(objectId)) return objectId;
        const asCode = String(
            typeof emp?.company === 'string' ? emp.company : emp?.company?.companyId || '',
        )
            .trim()
            .toUpperCase();
        if (asCode && companyCodeToId.has(asCode)) return companyCodeToId.get(asCode);
        return '';
    }

    const employees = [];
    for (const emp of people) {
        const code = String(emp.employeeId).trim();
        const enrollment = enrollmentByKey.get(employeeCodeKey(code));
        const storedEnrollment = storedByKey.get(employeeCodeKey(code));
        const isEnrolled = Boolean(enrollment);
        const enrolledForMonth = Boolean(
            storedEnrollment && enrollmentCoversSalaryMonth(storedEnrollment, salaryYm),
        );
        const monthlySalary = roundMoney(
            salaryAmountForMonth(getByEmployeeCode(salaryByCode, code), salaryYm),
        );
        const companyMolCode = isEnrolled
            ? getByEmployeeCode(molByCode, code) || getByEmployeeCode(molByCode, enrollment.employeeId) || ''
            : '';
        const isWps = Boolean(companyMolCode);
        totalSalary += monthlySalary;
        if (isEnrolled) {
            enrolled += 1;
            enrolledSalary += monthlySalary;
            if (isWps) wpsEnrolled += 1;
            else cashEnrolled += 1;
        }
        const companyKey = companyStatsKey(emp);
        const companyName = companyKey ? companyById.get(companyKey) || '' : '';
        const companyId = companyKey
            ? publicCompanyIdByMongo.get(companyKey) || companyKey
            : 'unassigned';
        if (companyKey) {
            const stats = byCompany.get(companyKey) || { enrolled: 0, totalActive: 0 };
            stats.totalActive += 1;
            if (isEnrolled) stats.enrolled += 1;
            byCompany.set(companyKey, stats);
        } else {
            unassigned.totalActive += 1;
            if (isEnrolled) unassigned.enrolled += 1;
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
            companyId,
            companyName,
            enrolled: isEnrolled,
            enrolledForMonth,
            status: String(emp.status || '').trim(),
            profileStatus: String(emp.profileStatus || '').trim(),
            monthlySalary,
            companyMolCode,
            isWps,
            paymentType: isEnrolled ? paymentTypeFromMol(companyMolCode) : '',
            fromMonth: String(storedEnrollment?.fromMonth || '').trim(),
            processingStart: processingStartFromEnrollment(storedEnrollment) || '',
            salaryDate: toMonthDay(storedEnrollment?.salaryDate),
        });
    }

    employees.sort((a, b) =>
        String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }),
    );

    const pendingRequests = await buildGroupPendingRequests(
        people.filter((emp) => enrollmentByKey.has(employeeCodeKey(emp.employeeId))),
        monthKey,
    );

    const companyRows = (companies || []).map((company) => {
        const stats = byCompany.get(String(company._id)) || { enrolled: 0, totalActive: 0 };
        return {
            companyId: String(company.companyId || company._id),
            name: String(company.nickName || company.name || 'Company').trim(),
            enrolled: stats.enrolled,
            totalActive: stats.totalActive,
        };
    });
    if (unassigned.totalActive > 0) {
        companyRows.push({
            companyId: 'unassigned',
            name: 'Unassigned',
            enrolled: unassigned.enrolled,
            totalActive: unassigned.totalActive,
        });
    }

    return {
        enrolled,
        totalActive: people.length,
        enrolledSalary: roundMoney(enrolledSalary),
        totalSalary: roundMoney(totalSalary),
        wpsEnrolled,
        cashEnrolled,
        companies: companyRows,
        workLocations: [...byLocation.values()],
        employees,
        pendingRequests,
    };
}

export async function monthPayrollIsClear(monthKey) {
    const overview = await buildEnrollmentOverview([], monthKey);
    const pending = Array.isArray(overview?.pendingRequests) ? overview.pendingRequests : [];
    const enrolled = Number(overview?.enrolled) || 0;
    return enrolled > 0 && pending.length === 0;
}

function currentSalaryYearMonth() {
    const dubai = getZonedParts(new Date(), getScheduledEmailTimeZone());
    return `${dubai.year}-${pad2(dubai.month)}`;
}

function activePayrollEmployee(emp) {
    if (!emp) return false;
    if (String(emp.status || '') === 'Left User') return false;
    return String(emp.profileStatus || '').trim().toLowerCase() === 'active';
}

function employeeWorkedInMonth(emp, ym) {
    const join = toYearMonth(emp?.dateOfJoining);
    if (join && join > ym) return false;
    if (String(emp?.status || '') === 'Left User') {
        // Current month and every later salary list stay empty for a Left User.
        if (ym >= currentSalaryYearMonth()) return false;
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

function overtimePunchMeta({ timeIn, timeOut, date, week }) {
    const actualIn = clockTimeToMinutes(timeIn);
    const actualOut = clockTimeToMinutes(timeOut);
    if (actualIn == null || actualOut == null) return { hours: 0, isOffDay: false };

    let worked = actualOut - actualIn;
    if (worked <= 0) worked += 24 * 60;

    const scheduled = getScheduledPunchMinutes(week, date);
    let scheduledMinutes = 0;
    if (!scheduled.isOffDay) {
        scheduledMinutes = (scheduled.endMinutes ?? 18 * 60) - (scheduled.startMinutes ?? 9 * 60);
        if (scheduledMinutes <= 0) scheduledMinutes += 24 * 60;
    }

    const otMinutes = scheduled.isOffDay ? worked : Math.max(0, worked - scheduledMinutes);
    if (otMinutes <= 0) return { hours: 0, isOffDay: Boolean(scheduled.isOffDay) };
    return {
        hours: otMinutes / 60,
        isOffDay: Boolean(scheduled.isOffDay),
    };
}

function daysInSalaryMonth(ym) {
    const match = String(ym || '').match(/^(\d{4})-(\d{2})$/);
    if (!match) return 30;
    return lastDayOfMonth(Number(match[1]), Number(match[2]));
}

function daySalaryForMonth(monthlySalary, ym) {
    const days = daysInSalaryMonth(ym);
    if (!(monthlySalary > 0) || days <= 0) return 0;
    return monthlySalary / days;
}

function policyTimes(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
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

function sumSalaryLines(lines) {
    const total = (lines || []).reduce((sum, row) => {
        const gross = row.zohoSalary != null && row.zohoSalary !== ''
            ? row.zohoSalary
            : row.grossSalary;
        sum.monthlySalary += Number(row.monthlySalary) || 0;
        sum.grossSalary += Number(gross) || 0;
        sum.basicSalary += Number(row.basicSalary) || 0;
        sum.ot += Number(row.ot) || 0;
        sum.deduction += Number(row.deduction) || 0;
        sum.actualSalary += Number(row.actualSalary) || 0;
        return sum;
    }, { monthlySalary: 0, grossSalary: 0, basicSalary: 0, ot: 0, deduction: 0, actualSalary: 0 });
    return {
        monthlySalary: roundMoney(total.monthlySalary),
        grossSalary: roundMoney(total.grossSalary),
        basicSalary: roundMoney(total.basicSalary),
        ot: roundMoney(total.ot),
        deduction: roundMoney(total.deduction),
        actualSalary: roundMoney(total.actualSalary),
    };
}

function applySlipFigure(row, figures) {
    if (!row || !figures) return;
    if (figures.monthlySalary > 0) row.monthlySalary = figures.monthlySalary;
    if (figures.basicSalary > 0) row.basicSalary = figures.basicSalary;
    row.deduction = figures.deduction;
    row.lossOfPay = money(figures.lossOfPay);
    row.otherDeduction = money(figures.otherDeduction);
    row.otherAllowance = roundMoney(figures.otherAllowance);
    row.presentDays = Number(figures.presentDays) || 0;
    row.sheetPresentDays = Number.isFinite(Number(figures.sheetPresentDays))
        ? Number(figures.sheetPresentDays)
        : row.presentDays;
    row.sheetLossOfPay = roundMoney(figures.sheetLossOfPay);
    row.zohoSalary = roundMoney(figures.zohoSalary);
    row.rewardAdditions = roundMoney(figures.rewardAdditions);
    row.grossSalary = roundMoney(figures.grossSalary);
    row.fineAmount = roundMoney(figures.fineAmount);
    row.advanceAmount = roundMoney(figures.advanceAmount);
    row.loanAmount = roundMoney(figures.loanAmount);
    row.sheetOtherDeduction = roundMoney(figures.sheetOtherDeduction);
    row.extra = figures.extra;
    row.ot = figures.ot;
    row.actualSalary = figures.actualSalary;
    row.netSalaryPayable = figures.netSalaryPayable ?? figures.actualSalary;
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

/** Enroll details: Company MOL code present → WPS, otherwise Cash. */
function paymentTypeFromMol(companyMolCode) {
    return String(companyMolCode || '').trim() ? 'WPS' : 'Cash';
}

async function companyMolByEmployeeId(ids) {
    const codes = [...new Set((ids || []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (!codes.length) return new Map();
    const docs = await SalaryHistoricalProfile.find({ employeeId: { $in: codes } })
        .select('employeeId companyMolCode')
        .lean()
        .maxTimeMS(8000);
    return new Map(
        (docs || []).map((doc) => [
            employeeCodeKey(doc.employeeId),
            String(doc.companyMolCode || '').trim(),
        ]),
    );
}

function companyDisplayName(company) {
    if (!company || typeof company !== 'object') return '';
    return String(company.nickName || company.name || '').trim();
}

function employeeCompanyLabel(emp) {
    return companyDisplayName(emp?.company) || 'Unassigned';
}

function listYearsInclusive(startYm, endYm) {
    const start = Number(String(startYm || '').slice(0, 4));
    const end = Number(String(endYm || '').slice(0, 4));
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1990 || end < 1990) {
        return [];
    }
    const lo = Math.min(start, end);
    const hi = Math.max(start, end);
    const years = [];
    for (let y = hi; y >= lo; y -= 1) years.push(String(y));
    return years;
}

function parseRegisterFilters(query = {}) {
    const year = String(query.year || '').trim();
    return {
        year: /^\d{4}$/.test(year) ? year : '',
        company: String(query.company || '').trim(),
        employeeId: employeeCodeKey(query.employeeId || query.employee || ''),
    };
}

function employeeMatchesRegisterFilter(emp, code, filters) {
    if (!filters) return true;
    if (filters.employeeId && employeeCodeKey(code) !== filters.employeeId) return false;
    if (filters.company) {
        const want = filters.company.toLowerCase();
        const label = employeeCompanyLabel(emp).toLowerCase();
        const nick = String(emp?.company?.nickName || '').trim().toLowerCase();
        const name = String(emp?.company?.name || '').trim().toLowerCase();
        const companyId = String(emp?.company?.companyId || emp?.company?._id || '').trim().toLowerCase();
        if (label !== want && nick !== want && name !== want && companyId !== want) return false;
    }
    return true;
}

function emptyRegisterPayload() {
    return { fromMonth: null, toMonth: null, months: [] };
}

function serializeMonthPayment(doc, names = new Map()) {
    if (!doc) return null;
    const status = slotStatusOf(doc);
    const createdBy = String(doc.createdBy || '');
    return {
        id: String(doc._id),
        monthKey: String(doc.monthKey || ''),
        paymentNo: Number(doc.paymentNo) || 0,
        selectedIds: (doc.employeeIds || []).map((id) => String(id || '').trim()).filter(Boolean),
        companyName: String(doc.companyName || '').trim(),
        paymentMethod: String(doc.paymentMethod || '').trim(),
        status,
        rejectReason: String(doc.rejectReason || '').trim(),
        processed: status === 'approved',
        createdAt: doc.createdAt || null,
        createdByName: names.get(createdBy) || String(doc.createdByName || '').trim(),
        zohoExpenseId: String(doc.zohoExpenseId || '').trim(),
    };
}

async function paymentCreatorNames(docs) {
    const ids = [...new Set(
        (docs || [])
            .map((doc) => String(doc?.createdBy || '').trim())
            .filter((id) => mongoose.Types.ObjectId.isValid(id)),
    )];
    if (!ids.length) return new Map();
    const users = await User.find({ _id: { $in: ids } }).select('name').lean();
    return new Map((users || []).map((user) => [String(user._id), String(user.name || '').trim()]));
}

async function serializeMonthPaymentWithName(doc) {
    const names = await paymentCreatorNames([doc]);
    return serializeMonthPayment(doc, names);
}

async function listMonthPayments(monthKey) {
    if (!monthKey) return [];
    const rows = await SalaryMonthPayment.find({ monthKey })
        .sort({ paymentNo: 1 })
        .lean()
        .maxTimeMS(8000);
    const names = await paymentCreatorNames(rows);
    return (rows || [])
        .map((doc) => serializeMonthPayment(doc, names))
        .filter((row) => row && row.status !== 'cancelled');
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
 * Latest salary period that may appear on the list.
 * August salary is processed in September, so the current calendar month is never listed yet.
 */
function lastOpenSalaryMonth(currentYm) {
    return addMonthsYm(currentYm, -1) || lastOpenSalaryProcessMonth();
}

/**
 * GET /api/Employee/salary-register
 * One row per salary period from the nearest enrolled process-start month
 * through last month. A period opens on the 1st of the following month
 * (October enrollment → October salary on 1 November).
 */
export const getSalaryRegister = async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const [payrollDoc, viewerIsSalaryHr, viewerIsSlotHr] = await Promise.all([
            PayrollSettings.findOne({ key: 'default' })
                .select('hiddenSalaryMonths salaryProcessingDate salaryProcessStartMonth')
                .lean()
                .maxTimeMS(5000),
            viewerIsSalaryFlowchartHr(req).catch(() => false),
            viewerIsFlowchartHrAssignee(req).catch(() => false),
        ]);
        const hiddenMonths = new Set(
            (payrollDoc?.hiddenSalaryMonths || []).map((ym) => String(ym || '').trim()).filter(Boolean),
        );

        const dubai = getZonedParts(new Date(), getScheduledEmailTimeZone());
        const currentYm = `${dubai.year}-${pad2(dubai.month)}`;
        const todayDay = Number(dubai.day) || 0;
        const detailYm = toYearMonth(req.params.monthKey || req.query.month);
        const registerFilters = parseRegisterFilters(req.query || {});

        const [enrollmentDocs, lockedProfiles] = await Promise.all([
            SalaryEnrollment.find({})
                .select('employeeId fromMonth monthKey createdAt processDate salaryDate')
                .lean()
                .maxTimeMS(8000),
            SalaryHistoricalProfile.find({ workflowStatus: 'locked' })
                .select('employeeId verpStartDate')
                .lean()
                .maxTimeMS(8000),
        ]);

        const storedEnrollmentByKey = normalizeEnrollmentRows(enrollmentDocs || []);
        const enrollmentByKey = normalizeEnrollmentRows([
            ...(enrollmentDocs || []),
            ...(lockedProfiles || []).map((row) => ({
                employeeId: row.employeeId,
                fromMonth: toYearMonth(row.verpStartDate),
            })),
        ]);
        const enrollments = [...enrollmentByKey.values()];

        const processDay = resolveProcessDay(payrollDoc, enrollments);
        const lastOpenYm = lastOpenSalaryMonth(currentYm);
        const enrollmentOverview = await buildEnrollmentOverview(enrollments, detailYm || lastOpenYm || currentYm);
        const policyStartYm = toYearMonth(payrollDoc?.salaryProcessStartMonth);
        const firstEnrollmentYm = enrollments.reduce((min, row) => {
            const ym = toYearMonth(row.fromMonth);
            if (!ym) return min;
            return !min || ym < min ? ym : min;
        }, null);

        // Nearest enrolled process-start month. That salary period opens on the 1st of the next month
        // (October enrollment → payroll row on 1 November).
        const startYm = firstEnrollmentYm || null;
        const payrollOpenYm = startYm ? salaryRegisterPayrollOpenMonth(startYm) : null;

        const waitingForOpenMonth = Boolean(startYm && lastOpenYm && startYm > lastOpenYm);
        const waitingForProcessingDate = waitingForOpenMonth;
        const nextOpenMonthKey = waitingForOpenMonth ? payrollOpenYm : null;

        const registerMeta = {
            enrolledCount: Number(enrollmentOverview?.enrolled) || enrollments.length,
            salaryProcessingDate: processDay ? String(processDay) : '',
            salaryProcessStartMonth: policyStartYm || '',
            waitingForProcessingDate,
            currentMonth: monthLabel(currentYm),
            currentMonthKey: currentYm,
            firstSalaryMonth: waitingForOpenMonth && startYm ? monthLabel(startYm) : '',
            firstSalaryMonthKey: waitingForOpenMonth && startYm ? startYm : '',
            nextOpenMonth: nextOpenMonthKey ? monthLabel(nextOpenMonthKey) : '',
            nextOpenMonthKey: nextOpenMonthKey || '',
            hiddenMonthCount: hiddenMonths.size,
            viewerIsSalaryHr: Boolean(viewerIsSalaryHr),
            viewerIsSlotHr: Boolean(viewerIsSlotHr),
            years: listYearsInclusive(startYm || currentYm, lastOpenYm || currentYm),
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

        if (detailYm && lastOpenYm && detailYm > lastOpenYm) {
            return res.status(404).json({
                message: 'This salary month is not open yet.',
            });
        }

        // Nearest enrolled process-start is still the current/future month: it opens on the 1st of next month.
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
                message: 'This salary month is not open yet.',
            });
        }

        const monthKeys = listMonthsInclusive(startYm, endYm).filter(
            (ym) => ym && lastOpenYm && ym <= lastOpenYm && ym < currentYm,
        );
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
        const enrolledKeySet = new Set(enrollments.map((row) => employeeCodeKey(row.employeeId)).filter(Boolean));

        const directoryRows = await EmployeeBasic.find({
            employeeId: { $nin: ['', 'VEGA-HR-0000'] },
            ...REAL_EMPLOYEE_MONGO_FILTER,
        })
            .select('_id employeeId firstName lastName staffType status dateOfJoining overtime noticeRequest.exitDate profileStatus company')
            .populate({ path: 'company', select: 'name nickName companyId' })
            .sort({ firstName: 1, lastName: 1 })
            .lean()
            .maxTimeMS(15000);

        const employees = (directoryRows || []).filter(
            (emp) => enrolledKeySet.has(employeeCodeKey(emp.employeeId)) && !isCompanyShellEmployee(emp),
        );
        const empByMongo = new Map(employees.map((emp) => [String(emp._id), emp]));
        const empByCode = new Map(employees.map((emp) => [employeeCodeKey(emp.employeeId), emp]));
        const codes = employees.map((emp) => emp.employeeId).filter(Boolean);
        const mongoIds = employees.map((emp) => String(emp._id));

        const salaryDocs = codes.length
            ? await EmployeeSalary.find({ employeeId: { $in: codes } })
                .select('-offerLetter.data -salaryHistory.attachment.data -salaryHistory.offerLetter.data')
                .lean()
                .maxTimeMS(15000)
            : [];
        const salaryByCode = new Map(
            salaryDocs.map((doc) => [employeeCodeKey(doc.employeeId), doc]),
        );
        const staffKeys = [...new Set(employees.map((emp) => normalizeStaffTypeKey(emp.staffType)).filter(Boolean))];
        const payrollKeys = ['default', ...staffKeys.map((key) => `group:${key}`)];
        const [molByCode, payrollDocs] = await Promise.all([
            companyMolByEmployeeId(codes),
            PayrollSettings.find({ key: { $in: payrollKeys } })
                .select('key authorizedLeaveDeductionDays unauthorizedLeaveDeductionDays lateInRules missedPunchRule extraLateRules')
                .lean()
                .maxTimeMS(8000),
        ]);
        const payrollByKey = new Map(
            (payrollDocs || []).map((doc) => [String(doc.key || ''), serializePayrollSettings(doc)]),
        );
        const defaultPolicy = payrollByKey.get('default') || serializePayrollSettings({});
        const policyForEmployee = (emp) => {
            const groupPolicy = payrollByKey.get(`group:${normalizeStaffTypeKey(emp?.staffType)}`);
            if (!groupPolicy) return defaultPolicy;
            const groupExtras = Array.isArray(groupPolicy.extraLateRules) ? groupPolicy.extraLateRules : [];
            const mainExtras = Array.isArray(defaultPolicy.extraLateRules) ? defaultPolicy.extraLateRules : [];
            const groupHasDeduct = groupExtras.some((row) => String(row?.deduct || '').trim());
            const mainHasDeduct = mainExtras.some((row) => String(row?.deduct || '').trim());
            if (!groupHasDeduct && mainHasDeduct) {
                return { ...groupPolicy, extraLateRules: mainExtras };
            }
            return groupPolicy;
        };
        const pendingEmployeeIds = new Set(
            (enrollmentOverview?.pendingRequests || [])
                .map((row) => employeeCodeKey(row?.employeeId))
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
                const salaryDoc = getByEmployeeCode(salaryByCode, code);
                const monthlySalary = salaryAmountForMonth(salaryDoc, ym);
                const week = getWeekForStaffType(workingTime, emp.staffType);
                const ot = overtimePunchMeta({
                    timeIn: punch.timeIn,
                    timeOut: punch.timeOut,
                    date: punch.date,
                    week,
                });
                if (ot.hours <= 0) continue;
                const daily = daySalaryForMonth(monthlySalary, ym);
                addOt(code, ym, ot.isOffDay ? daily : (daily / 10) * ot.hours);
            }
        }

        const deductionByKey = new Map();
        const addDeduction = (code, ym, amount) => {
            if (!code || !ym || amount <= 0) return;
            const key = `${code}|${ym}`;
            deductionByKey.set(key, (deductionByKey.get(key) || 0) + amount);
        };

        const leaveRows = mongoIds.length
            ? await Attendance.find({
                employeeMongoId: { $in: mongoIds },
                date: { $gte: from, $lte: to },
                statusKey: { $in: ['authorized_leave', 'unauthorized_leave'] },
            })
                .select('employeeMongoId date statusKey reason timeIn timeOut leaveRequestDayPart leaveDayFraction leaveDeductionTimes deductionWaived hourAdjustMode hourAdjustStatus hoursApproved hoursTaken')
                .lean()
                .maxTimeMS(15000)
            : [];

        const [processingProfiles, processingEnrollments] = await Promise.all([
            SalaryHistoricalProfile.find({ employeeId: { $in: codes } })
                .select('employeeId verpStartDate')
                .lean()
                .maxTimeMS(12000),
            SalaryEnrollment.find({ employeeId: { $in: codes } })
                .select('employeeId fromMonth salaryDate processDate')
                .lean()
                .maxTimeMS(12000),
        ]);
        const verpByCode = new Map(
            (processingProfiles || []).map((row) => [employeeCodeKey(row.employeeId), row.verpStartDate]),
        );
        const enrollmentByCode = new Map(
            (processingEnrollments || []).map((row) => [employeeCodeKey(row.employeeId), row]),
        );
        const processingStartFor = (emp) =>
            resolveSalaryProcessingStartDate({
                verpStartDate: verpByCode.get(employeeCodeKey(emp?.employeeId)),
                enrollment: enrollmentByCode.get(employeeCodeKey(emp?.employeeId)),
            });

        for (const row of leaveRows) {
            if (isDeductionWaived(row) || isHourLossWaived(row)) continue;
            const key = String(row?.statusKey || '');
            const ym = String(row?.date || '').slice(0, 7);
            if (!/^\d{4}-\d{2}$/.test(ym)) continue;
            const emp = empByMongo.get(String(row?.employeeMongoId || ''));
            if (!emp) continue;
            if (!keepAttendanceForProcessingStart(row, processingStartFor(emp))) continue;
            const part = String(row.leaveRequestDayPart || '');
            const fraction = part === 'half' || part === 'quarter'
                ? partialLeavePortion(part)
                : Number(row.leaveDayFraction) > 0 && Number(row.leaveDayFraction) < 1
                    ? Number(row.leaveDayFraction)
                    : 1;
            const doubled = key === 'authorized_leave' && Number(row.leaveDeductionTimes) === 2 ? 2 : 1;
            const code = String(emp.employeeId || '').trim();
            const monthly = salaryAmountForMonth(getByEmployeeCode(salaryByCode, code), ym);
            const daily = daySalaryForMonth(monthly, ym);
            const chosenShare = key === 'authorized_leave' ? explicitAuthorizedHourShare(row) : null;
            if (chosenShare != null) {
                addDeduction(code, ym, daily * chosenShare * fraction);
                continue;
            }
            const policy = policyForEmployee(emp);
            let times = 0;
            if (key === 'authorized_leave') {
                times = policyTimes(policy.authorizedLeaveDeductionDays, 1);
            } else if (key === 'unauthorized_leave') {
                times = policyTimes(policy.unauthorizedLeaveDeductionDays, 2);
            } else {
                continue;
            }
            addDeduction(code, ym, daily * times * fraction * doubled);
        }

        if (mongoIds.length) {
            const workingTime = await loadWorkingTimeDoc();
            const lateRows = await Attendance.find({
                employeeMongoId: { $in: mongoIds },
                date: { $gte: from, $lte: to },
                statusKey: { $in: ['late_arrived', 'early_go'] },
            })
                .select('employeeMongoId date timeIn timeOut timeOutDate punchSessions flexibleWorkedHours hourAdjustStatus hoursApproved statusKey deductionWaived')
                .lean()
                .maxTimeMS(15000);

            const lateRowsByKey = new Map();
            const seenLateDates = new Set();
            for (const row of lateRows || []) {
                if (isDeductionWaived(row)) continue;
                const emp = empByMongo.get(String(row.employeeMongoId || ''));
                if (!emp) continue;
                const date = String(row.date || '').slice(0, 10);
                const ym = date.slice(0, 7);
                if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{4}-\d{2}$/.test(ym)) continue;
                const stamp = `${emp._id}|${date}`;
                if (seenLateDates.has(stamp)) continue;
                seenLateDates.add(stamp);
                const code = String(emp.employeeId || '').trim();
                const mapKey = `${code}|${ym}`;
                const list = lateRowsByKey.get(mapKey) || [];
                list.push(row);
                lateRowsByKey.set(mapKey, list);
            }

            const missedRows = await Attendance.find({
                employeeMongoId: { $in: mongoIds },
                date: { $gte: from, $lte: to },
                statusKey: 'mispunch',
            })
                .select('employeeMongoId date deductionWaived hourAdjustStatus hoursApproved')
                .lean()
                .maxTimeMS(15000);
            const missedByKey = new Map();
            for (const row of missedRows || []) {
                if (isDeductionWaived(row) || isHourLossWaived(row)) continue;
                const emp = empByMongo.get(String(row.employeeMongoId || ''));
                if (!emp) continue;
                const ym = String(row.date || '').slice(0, 7);
                if (!/^\d{4}-\d{2}$/.test(ym)) continue;
                const code = String(emp.employeeId || '').trim();
                const mapKey = `${code}|${ym}`;
                missedByKey.set(mapKey, (missedByKey.get(mapKey) || 0) + 1);
            }
            for (const [mapKey, count] of missedByKey.entries()) {
                const [code, ym] = String(mapKey).split('|');
                const emp = getByEmployeeCode(empByCode, code);
                if (!emp) continue;
                const monthly = salaryAmountForMonth(getByEmployeeCode(salaryByCode, code), ym);
                const daily = daySalaryForMonth(monthly, ym);
                const missedCharge = missedPunchDeduction(count, policyForEmployee(emp));
                addDeduction(code, ym, daily * missedCharge.dayFraction);
            }

            const punchRows = await Attendance.find({
                employeeMongoId: { $in: mongoIds },
                date: { $gte: from, $lte: to },
                timeIn: { $nin: ['', null] },
            })
                .select('employeeMongoId date timeIn timeOut timeOutDate punchSessions flexibleWorkedHours hourAdjustStatus hoursApproved statusKey deductionWaived')
                .lean()
                .maxTimeMS(15000);
            const punchesByKey = new Map();
            for (const row of punchRows || []) {
                if (isDeductionWaived(row)) continue;
                const emp = empByMongo.get(String(row.employeeMongoId || ''));
                if (!emp) continue;
                const ym = String(row.date || '').slice(0, 7);
                if (!/^\d{4}-\d{2}$/.test(ym)) continue;
                const code = String(emp.employeeId || '').trim();
                const mapKey = `${code}|${ym}`;
                const list = punchesByKey.get(mapKey) || [];
                list.push(row);
                punchesByKey.set(mapKey, list);
            }
            const lateKeys = new Set([...lateRowsByKey.keys(), ...punchesByKey.keys()]);
            for (const mapKey of lateKeys) {
                const [code, ym] = String(mapKey).split('|');
                const emp = getByEmployeeCode(empByCode, code);
                if (!emp) continue;
                const byDate = new Map();
                for (const row of [...(lateRowsByKey.get(mapKey) || []), ...(punchesByKey.get(mapKey) || [])]) {
                    const date = String(row?.date || '').slice(0, 10);
                    if (!date) continue;
                    const current = byDate.get(date);
                    if (!current || (!current.timeIn && row.timeIn)) byDate.set(date, row);
                }
                const monthly = salaryAmountForMonth(getByEmployeeCode(salaryByCode, code), ym);
                const daily = daySalaryForMonth(monthly, ym);
                const summary = lateInOutSummary(
                    [...byDate.values()],
                    policyForEmployee(emp),
                    getWeekForStaffType(workingTime, emp.staffType),
                );
                addDeduction(code, ym, daily * (summary.lateIn.dayFraction + summary.lateOut.dayFraction));
            }
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
            const emp = getByEmployeeCode(empByCode, loan.employeeId);
            if (!emp) continue;
            const code = String(emp.employeeId || '').trim();
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
                    const emp = getByEmployeeCode(empByCode, assignee?.employeeId);
                    if (!emp) continue;
                    const code = String(emp.employeeId || '').trim();
                    const payable =
                        resolveEmployeeFinePayableAmount(fine, String(assignee?.employeeId || '').trim()) ||
                        resolveEmployeeFinePayableAmount(fine, code);
                    if (payable <= 0) continue;
                    addDeduction(code, ym, payable / duration);
                }
            }
        }

        function codesEnrolledInMonth(ym) {
            const codesForMonth = [];
            const seen = new Set();
            for (const row of enrollments) {
                const key = employeeCodeKey(row.employeeId);
                if (!key || seen.has(key)) continue;
                const stored = storedEnrollmentByKey.get(key);
                if (!stored || !enrollmentCoversSalaryMonth(stored, ym)) continue;
                if (!ym || ym > lastOpenYm || ym >= currentYm) continue;
                const emp = empByCode.get(key);
                if (!emp || !employeeWorkedInMonth(emp, ym) || !activePayrollEmployee(emp)) continue;
                const code = String(emp.employeeId || '').trim();
                if (!employeeMatchesRegisterFilter(emp, code, registerFilters)) continue;
                seen.add(key);
                codesForMonth.push(code);
            }
            return codesForMonth;
        }

        const linesByMonth = new Map();
        const enrolledIdsByMonth = new Map();
        const monthPayments = detailYm ? await listMonthPayments(detailYm) : [];
        const processedEmployeeIds = new Set(
            monthPayments
                .filter((row) => row.processed)
                .flatMap((row) => row.selectedIds || [])
                .map((id) => employeeCodeKey(id))
                .filter(Boolean),
        );
        const months = [...monthKeys].reverse().map((ym, index) => {
            const monthCodes = codesEnrolledInMonth(ym);
            enrolledIdsByMonth.set(ym, monthCodes);
            const lines = [];
            for (const code of monthCodes) {
                const emp = getByEmployeeCode(empByCode, code);
                const salaryDoc = getByEmployeeCode(salaryByCode, code);
                const empMonthly = salaryAmountForMonth(salaryDoc, ym);
                const empBasic = basicAmountForMonth(salaryDoc, ym);
                const empOt = otByKey.get(`${code}|${ym}`) || 0;
                const empDeduction = deductionByKey.get(`${code}|${ym}`) || 0;
                const enrollmentRow = storedEnrollmentByKey.get(employeeCodeKey(code));
                lines.push({
                    slNo: lines.length + 1,
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
                    extra: roundMoney(empOt),
                    deduction: roundMoney(empDeduction),
                    paymentType: paymentTypeFromMol(getByEmployeeCode(molByCode, code)),
                    enrolled: true,
                    enrolledForMonth: true,
                    fromMonth: String(enrollmentRow?.fromMonth || '').trim(),
                    processingStart: processingStartFromEnrollment(enrollmentRow) || '',
                    status: String(emp?.status || '').trim(),
                    profileStatus: String(emp?.profileStatus || '').trim(),
                    status: processedEmployeeIds.has(employeeCodeKey(code))
                        ? 'Processed'
                        : pendingEmployeeIds.has(employeeCodeKey(code))
                            ? 'Pending'
                            : 'Ready',
                });
            }
            linesByMonth.set(ym, lines);
            return {
                slNo: index + 1,
                monthKey: ym,
                month: monthRowLabel(ym),
                enrollUser: lines.length,
                ...sumSalaryLines(lines),
            };
        });

        let visibleMonths = months.filter((row) => !hiddenMonths.has(row.monthKey));
        if (registerFilters.year) {
            visibleMonths = visibleMonths.filter((row) => String(row.monthKey || '').startsWith(registerFilters.year));
        }
        if (registerFilters.employeeId || registerFilters.company) {
            visibleMonths = visibleMonths.filter((row) => Number(row.enrollUser) > 0);
        }

        const monthsToPrice = new Set(visibleMonths.map((row) => row.monthKey).filter(Boolean));
        if (detailYm) monthsToPrice.add(detailYm);
        for (const ym of monthsToPrice) {
            const lines = linesByMonth.get(ym) || [];
            if (!lines.length) continue;
            const slipFigures = await collectSalarySlipPayrollFigures(
                lines.map((row) => row.employeeId),
                ym,
            );
            for (const row of lines) {
                applySlipFigure(row, slipFigures.get(employeeCodeKey(row.employeeId)));
            }
            const monthRow = months.find((row) => row.monthKey === ym);
            if (monthRow) Object.assign(monthRow, sumSalaryLines(lines));
        }
        const employeesForMonth = detailYm ? (linesByMonth.get(detailYm) || []) : [];

        visibleMonths = visibleMonths.map((row, index) => ({ ...row, slNo: index + 1 }));
        const visibleMonthKeys = visibleMonths.map((row) => row.monthKey).filter(Boolean);
        const [dmfRows, slotRows] = await Promise.all([
            SalaryMonthDmf.find({
                monthKey: { $in: visibleMonthKeys },
            })
                .select('monthKey dmfApproval zohoJournalUpdatedAt')
                .lean(),
            visibleMonthKeys.length
                ? SalaryMonthPayment.find({ monthKey: { $in: visibleMonthKeys } })
                    .select('monthKey status employeeIds')
                    .lean()
                : [],
        ]);
        const dmfByMonth = new Map(
            (dmfRows || []).map((row) => [String(row.monthKey), row]),
        );
        const slotsByMonth = new Map();
        for (const slot of slotRows || []) {
            const key = String(slot.monthKey || '');
            if (!slotsByMonth.has(key)) slotsByMonth.set(key, []);
            slotsByMonth.get(key).push(slot);
        }
        const dmfCtx = await buildDmfViewerContext(req);
        visibleMonths = visibleMonths.map((row) => {
            const monthDoc = dmfByMonth.get(String(row.monthKey));
            const dmf = monthDoc?.dmfApproval;
            const serialized = serializeDmf(dmf, { ready: true, ctx: dmfCtx, flow: 'month' });
            return {
                ...row,
                processStatus: monthPayrollProcessStatusLabel(dmf),
                paymentStatus: salaryMonthPaymentLabel({
                    enrolledIds: enrolledIdsByMonth.get(row.monthKey) || [],
                    slots: slotsByMonth.get(String(row.monthKey)) || [],
                }),
                canAct: Boolean(serialized.canAct),
                dmfStatus: serialized.status,
                currentStepKey: serialized.currentStepKey,
            };
        });

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
            dmf: detailYm
                ? {
                    ...serializeDmf(dmfByMonth.get(String(detailYm))?.dmfApproval, { ready: true, ctx: dmfCtx, flow: 'month' }),
                    zohoJournalUpdated: Boolean(dmfByMonth.get(String(detailYm))?.zohoJournalUpdatedAt),
                }
                : undefined,
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

function payrollBlockerPath(item) {
    const explicit = String(item?.path || '').trim();
    if (explicit.startsWith('/')) return explicit;
    const id = encodeURIComponent(String(item?.employeeId || '').trim());
    const mongoId = String(item?.mongoId || '').trim();
    const key = String(item?.id || '');
    const category = String(item?.category || '');
    const title = String(item?.title || '');
    if (key.startsWith('fine-') || (/fine/i.test(title) && !key.startsWith('hub-') && !key.startsWith('loan-'))) {
        const fineId = String(item?.requestId || '').trim();
        if (fineId && mongoose.isValidObjectId(fineId)) return `/HRM/Fine/${fineId}`;
        const params = new URLSearchParams({ status: 'Pending' });
        params.set('tab', item?.isGroup ? 'group' : 'individual');
        const focus = String(item?.fineId || fineId).trim();
        if (focus) params.set('focusFine', focus);
        return `/HRM/Fine?${params.toString()}`;
    }
    if (key.startsWith('hub-')) {
        const hubId = key.slice(4);
        return hubId ? `/dashboard?hubRequestId=${encodeURIComponent(hubId)}` : '/dashboard';
    }
    if (key.startsWith('loan-')) {
        const loanId = key.slice(5);
        return loanId ? `/HRM/LoanAndAdvance/${loanId}` : '/HRM/LoanAndAdvance';
    }
    if (key.startsWith('asset-') || category === 'asset') return '/HRM/Asset';
    if (key.startsWith('util-')) return '/HRM/Asset/UtilityBills';
    if (category === 'finance') return '/HRM/LoanAndAdvance';
    if (category === 'attendance' || category === 'leave' || category === 'overtime' || category === 'compoff') {
        if (mongoId) {
            const month = String(item?.monthKey || '').trim();
            return `/HRM/Leave/${mongoId}${month ? `?month=${encodeURIComponent(month)}` : ''}`;
        }
        return id ? `/HRM/Leave?employee=${id}` : '/HRM/Leave';
    }
    return id ? `/HRM/Salary/enroll/${id}` : '/HRM/Salary';
}

const BLOCKER_CATEGORIES = new Set(['attendance', 'leave', 'finance', 'overtime', 'compoff', 'asset']);
const BLOCKER_CATEGORY_LABEL = {
    attendance: 'Attendance',
    leave: 'Leave',
    finance: 'Finance',
    overtime: 'Overtime',
    compoff: 'Comp-off',
    asset: 'Asset',
};

function employeeReminderEmail(emp) {
    const personal = String(emp?.email || '').trim().toLowerCase();
    if (personal) return personal;
    return String(emp?.companyEmail || emp?.workEmail || emp?.personalEmail || '')
        .trim()
        .toLowerCase();
}

function displayHodName(emp) {
    return `${emp?.firstName || ''} ${emp?.lastName || ''}`.trim() || String(emp?.employeeId || '').trim();
}

function reminderAudienceFromPolicies(docs) {
    const audiences = new Set();
    for (const doc of docs || []) {
        for (const row of doc?.salaryProcessReminders || []) {
            for (const key of reminderAudienceList(row?.forWhom)) audiences.add(key);
        }
    }
    return audiences;
}

async function flowchartPeopleForReminderAudiences(audiences) {
    const people = [];
    const seen = new Set();
    async function push(empPromise, role) {
        const emp = await empPromise;
        const employeeId = String(emp?.employeeId || '').trim();
        if (!emp || !employeeId || seen.has(employeeId)) return;
        seen.add(employeeId);
        people.push({
            employeeId,
            name: displayHodName(emp),
            role,
            email: employeeReminderEmail(emp),
        });
    }
    if (audiences.has('wfAccounts')) await push(getDepartmentHOD('accounts'), 'WF Accounts');
    if (audiences.has('wfHr')) await push(getDepartmentHOD('hr'), 'WF HR');
    if (audiences.has('wfAdmin')) await push(getDepartmentHOD('admincontroller'), 'WF Admin');
    if (audiences.has('wfManagement')) await push(getManagementHOD(), 'WF Management');
    return people;
}

function normalizeIncomingBlockerTask(row) {
    if (!row || typeof row !== 'object') return null;
    const employeeId = String(row.employeeId || '').trim();
    if (!employeeId) return null;
    const category = String(row.category || '').trim().toLowerCase();
    const path = String(row.path || '').trim() || payrollBlockerPath(row);
    return {
        id: String(row.id || '').trim(),
        employeeId,
        name: String(row.name || employeeId).trim(),
        title: String(row.title || 'Pending task').trim(),
        detail: String(row.detail || '').trim(),
        category,
        path: path.startsWith('/') ? path : payrollBlockerPath(row),
        responsibleId: String(row.responsibleId || '').trim(),
        responsibleName: String(row.responsibleName || '').trim(),
        responsibleRole: String(row.responsibleRole || '').trim(),
    };
}

/**
 * POST /api/Employee/salary-register/:monthKey/blockers/remind
 * One email per employee listing every matching pending item as a numbered link.
 * Prefers the visible modal task list from the client so tab / category / employee filters apply.
 */
export const sendPayrollBlockerReminders = async (req, res) => {
    try {
        const monthKey = toYearMonth(req.params.monthKey || req.body?.monthKey);
        if (!monthKey) {
            return res.status(400).json({ message: 'Invalid salary month.' });
        }

        const incomingTasks = (Array.isArray(req.body?.tasks) ? req.body.tasks : [])
            .map(normalizeIncomingBlockerTask)
            .filter(Boolean);

        let items = incomingTasks;
        if (!items.length) {
            const category = String(req.body?.category || '').trim().toLowerCase();
            const employeeFilter = new Set(
                (Array.isArray(req.body?.employeeIds) ? req.body.employeeIds : [])
                    .map((id) => String(id || '').trim())
                    .filter(Boolean),
            );
            const taskFilter = new Set(
                (Array.isArray(req.body?.taskIds) ? req.body.taskIds : [])
                    .map((id) => String(id || '').trim())
                    .filter(Boolean),
            );

            const employeeRows = await EmployeeBasic.find({
                employeeId: { $nin: ['', 'VEGA-HR-0000'] },
                status: { $ne: 'Left User' },
                profileStatus: 'active',
                ...REAL_EMPLOYEE_MONGO_FILTER,
            })
                .select('employeeId firstName lastName staffType email companyEmail primaryReportee')
                .lean()
                .maxTimeMS(12000);

            const people = (employeeRows || []).filter((emp) => {
                const code = String(emp?.employeeId || '').trim();
                return Boolean(code && !isPlaceholderEmployeeId(code) && !isCompanyShellEmployee(emp));
            });

            items = await buildGroupPendingRequests(people, monthKey);
            if (category && BLOCKER_CATEGORIES.has(category)) {
                items = items.filter((item) => String(item.category || '') === category);
            }
            if (employeeFilter.size) {
                items = items.filter((item) => {
                    const actor = String(item.responsibleId || '').trim();
                    const subject = String(item.employeeId || '').trim();
                    return employeeFilter.has(actor) || employeeFilter.has(subject);
                });
            }
            if (taskFilter.size) {
                items = items.filter((item) => taskFilter.has(String(item.id || '').trim()));
            }
        }

        const policyDocs = await PayrollSettings.find({
            $or: [{ key: 'default' }, { key: { $regex: /^group:/ } }],
        })
            .select('salaryProcessReminders')
            .lean()
            .maxTimeMS(8000);
        const audiences = reminderAudienceFromPolicies(policyDocs);
        const includePendingTaskUser = audiences.size === 0 || audiences.has('pendingTaskUser');
        const flowchartPeople = await flowchartPeopleForReminderAudiences(audiences);

        const byActor = new Map();
        function addTaskToActor(actorId, name, role, item) {
            const id = String(actorId || '').trim();
            if (!id) return;
            if (!byActor.has(id)) {
                byActor.set(id, {
                    employeeId: id,
                    name: name || id,
                    role: role || '',
                    tasks: [],
                });
            }
            const bucket = byActor.get(id);
            const taskKey = String(item.id || `${item.category}-${item.title}-${item.detail}`);
            if (bucket.tasks.some((task) => String(task.id || '') === taskKey)) return;
            bucket.tasks.push({ ...item, id: taskKey });
        }

        for (const item of items) {
            if (includePendingTaskUser) {
                addTaskToActor(item.responsibleId, item.responsibleName || item.name, item.responsibleRole, item);
            }
            for (const person of flowchartPeople) {
                addTaskToActor(person.employeeId, person.name, person.role, item);
            }
        }

        if (!byActor.size) {
            return res.status(200).json({ sent: 0, skipped: 0, employees: 0, items: 0, monthKey });
        }

        const people = await EmployeeBasic.find({
            employeeId: { $in: [...byActor.keys()] },
        })
            .select('employeeId firstName lastName email companyEmail')
            .lean()
            .maxTimeMS(8000);

        const emailByCode = new Map(
            (people || []).map((emp) => [
                String(emp.employeeId || '').trim(),
                employeeReminderEmail(emp),
            ]),
        );
        for (const person of flowchartPeople) {
            const code = String(person.employeeId || '').trim();
            if (code && person.email && !emailByCode.get(code)) {
                emailByCode.set(code, person.email);
            }
        }
        for (const emp of people || []) {
            const code = String(emp.employeeId || '').trim();
            const row = byActor.get(code);
            if (!row) continue;
            const fullName = `${emp.firstName || ''} ${emp.lastName || ''}`.trim();
            if (fullName) row.name = fullName;
        }

        const label = monthLabel(monthKey);
        let sent = 0;
        let skipped = 0;

        for (const row of byActor.values()) {
            const to = emailByCode.get(row.employeeId) || '';
            if (!to) {
                skipped += 1;
                continue;
            }
            const taskLines = row.tasks
                .map((task) => {
                    const extra = String(task.detail || '').trim();
                    const href = withFrontendPath(task.path || payrollBlockerPath(task), req);
                    const category = BLOCKER_CATEGORY_LABEL[task.category] || '';
                    const subject = `${task.name || task.employeeId} (${task.employeeId})`;
                    const due = String(task.waitingLabel || '').trim();
                    const labelText = `${category ? `${category}: ` : ''}${task.title || 'Pending task'}${extra ? ` — ${extra}` : ''
                        }${due && due !== '—' ? ` · due ${due}` : ''}`;
                    return `<li style="margin:0 0 10px"><span><strong>${escapeHtml(subject)}</strong> — ${escapeHtml(labelText)}</span><br/><a href="${escapeHtml(href)}">${escapeHtml(href)}</a></li>`;
                })
                .join('');
            sendMailLater({
                to,
                subject: `Payroll actions waiting — ${label}`,
                html: `
                    <p>Hello ${escapeHtml(row.name)},</p>
                    <p>These payroll items are waiting on you${row.role ? ` (${escapeHtml(row.role)})` : ''
                    } for <strong>${escapeHtml(label)}</strong>. One reminder is sent with every task you need to complete.</p>
                    <ol style="padding-left:20px">${taskLines}</ol>
                    <p>Open each link to complete the task.</p>
                `,
            });
            sent += 1;
        }

        return res.status(200).json({
            sent,
            skipped,
            employees: byActor.size,
            items: [...byActor.values()].reduce((sum, row) => sum + row.tasks.length, 0),
            monthKey,
        });
    } catch (error) {
        console.error('[sendPayrollBlockerReminders]', error);
        return res.status(500).json({ message: error.message || 'Failed to send payroll reminders.' });
    }
};

function slotPersonName(emp) {
    return `${emp?.firstName || ''} ${emp?.lastName || ''}`.trim() || emp?.employeeId || '';
}

function slotRequestIds(body) {
    const rawIds = Array.isArray(body?.employeeIds)
        ? body.employeeIds
        : Array.isArray(body?.selectedIds)
            ? body.selectedIds
            : [];
    return [...new Set(rawIds.map((id) => String(id || '').trim()).filter(Boolean))];
}

async function assertMonthReadyForSlots(monthKey) {
    const monthDmf = await SalaryMonthDmf.findOne({ monthKey }).select('dmfApproval.status').lean();
    if (String(monthDmf?.dmfApproval?.status || '') !== 'approved') {
        const error = new Error('Create slot opens after Management approves the payroll.');
        error.statusCode = 400;
        throw error;
    }
}

async function assertZohoJournalUpdated(monthKey) {
    const monthDmf = await SalaryMonthDmf.findOne({ monthKey }).select('zohoJournalUpdatedAt').lean();
    if (!monthDmf?.zohoJournalUpdatedAt) {
        const error = new Error('Create slot opens after the Zoho journal is published.');
        error.statusCode = 400;
        throw error;
    }
}

async function prepareSlotSelection({ monthKey, requested, companyName, ignorePaymentId }) {
    const company = String(companyName || '').trim();
    if (!company) {
        const error = new Error('Select a company.');
        error.statusCode = 400;
        throw error;
    }
    if (!requested.length) {
        const error = new Error('Select at least one employee.');
        error.statusCode = 400;
        throw error;
    }

    const existing = await SalaryMonthPayment.find({ monthKey })
        .select('employeeIds paymentNo status')
        .lean()
        .maxTimeMS(8000);
    const claimed = new Set();
    let lastNo = 0;
    for (const row of existing || []) {
        lastNo = Math.max(lastNo, Number(row.paymentNo) || 0);
        if (ignorePaymentId && String(row._id) === String(ignorePaymentId)) continue;
        if (!slotHoldsEmployees(row)) continue;
        for (const id of row.employeeIds || []) {
            const key = employeeCodeKey(id);
            if (key) claimed.add(key);
        }
    }
    if (requested.some((id) => claimed.has(employeeCodeKey(id)))) {
        const error = new Error('One or more employees are already in a slot for this month.');
        error.statusCode = 409;
        throw error;
    }

    const compOffBlock = await unsettledCompOffMessage(requested, monthKey);
    if (compOffBlock) {
        const error = new Error(compOffBlock);
        error.statusCode = 400;
        throw error;
    }

    const enrolled = await SalaryEnrollment.find({
        employeeId: { $in: requested },
        fromMonth: { $lte: monthKey },
    })
        .select('employeeId fromMonth salaryDate processDate')
        .lean()
        .maxTimeMS(8000);
    const enrolledKeys = new Set(
        (enrolled || [])
            .filter((row) => enrollmentCoversSalaryMonth(row, monthKey))
            .map((row) => employeeCodeKey(row.employeeId))
            .filter(Boolean),
    );
    if (requested.some((id) => !enrolledKeys.has(employeeCodeKey(id)))) {
        const error = new Error('Only enrolled employees can be added to a slot.');
        error.statusCode = 400;
        throw error;
    }

    const people = await EmployeeBasic.find({ employeeId: { $in: requested } })
        .select('employeeId company')
        .populate('company', 'nickName name')
        .lean();
    const byCode = new Map((people || []).map((person) => [employeeCodeKey(person.employeeId), person]));
    const mol = await companyMolByEmployeeId(requested);
    const types = [];
    for (const id of requested) {
        const label = employeeCompanyLabel(byCode.get(employeeCodeKey(id)));
        if (label.toLowerCase() !== company.toLowerCase()) {
            const error = new Error('Every employee in the slot must belong to the selected company.');
            error.statusCode = 400;
            throw error;
        }
        types.push(paymentTypeFromMol(getByEmployeeCode(mol, id)));
    }
    const typed = singleSlotPayType(types);
    if (!typed.ok || !typed.method) {
        const error = new Error(typed.message || 'A slot can include only WPS or only Cash employees.');
        error.statusCode = 400;
        throw error;
    }
    return { employeeIds: requested, companyName: company, paymentMethod: typed.method, lastNo };
}

async function mailSlotHr(_req, monthKey, slotNo) {
    const hr = await resolveFlowchartHrEmployee();
    if (hr?.error || !hr?.email) {
        console.warn('[salary slot] HR email missing', hr?.message || '');
        return;
    }
    sendMailLater({
        to: hr.email,
        subject: 'Payroll Processing – Request for HR Approval',
        html: buildSlotHrApprovalEmailHtml({ slotNo, monthKey }),
    });
}

async function mailSlotAccountsNext(req, monthKey, doc) {
    const accounts = await getDepartmentHOD('accounts');
    const to = String(accounts?.companyEmail || accounts?.email || '').trim();
    if (!to || !doc) return;
    const slotNo = Number(doc.paymentNo) || 0;
    const cash = String(doc.paymentMethod || '').trim().toUpperCase() === 'CASH';
    let file = null;
    try {
        file = await buildSalarySlotFile(doc);
    } catch (error) {
        console.error('[salary slot] excel', error?.message || error);
    }
    const monthLabel = payrollMonthLabel(monthKey);
    sendMailLater({
        to,
        subject: cash
            ? `Payroll Processing – Cash Salary – Salary Slot ${slotNo}`
            : `Payroll Processing – WPS File – Salary Slot ${slotNo}`,
        html: buildSlotAccountsEmailHtml({
            slotNo,
            monthKey,
            monthLabel,
            method: cash ? 'CASH' : 'WPS',
            attached: Boolean(file?.content),
            payrollUrl: cash
                ? ''
                : withFrontendPath(`/HRM/Salary/${encodeURIComponent(monthKey)}`, req),
        }),
        attachments: file?.content
            ? [{
                filename: file.filename,
                content: file.content,
                contentType: file.contentType,
            }]
            : undefined,
    });
}

async function mailSlotAccounts(req, monthKey, slotNo, reason) {
    const accounts = await getDepartmentHOD('accounts');
    const to = String(accounts?.companyEmail || accounts?.email || '').trim();
    if (!to) return;
    sendSalarySlotMail({
        req,
        to,
        name: slotPersonName(accounts) || 'Accounts',
        subject: `${monthKey} salary slot ${slotNo} was rejected`,
        monthKey,
        lines: [
            `HR rejected slot ${slotNo}.`,
            reason ? `Reason: ${reason}` : 'The slot is back with Accounts.',
        ],
    });
}

async function applyApprovedSlotSideEffects(employeeIds, monthKey) {
    const { applySalarySlipLeaveTicketPaymentsForEmployee } = await import(
        '../../utils/applySalarySlipLeaveTicketPayments.js'
    );
    for (const id of employeeIds) {
        try {
            await applySalarySlipLeaveTicketPaymentsForEmployee(id, monthKey);
        } catch (error) {
            console.error('[salary slot] leave ticket', id, error?.message || error);
        }
    }
}

function slotErrorResponse(res, error, logLabel) {
    if (error?.code === 11000) {
        return res.status(409).json({ message: 'Slot number already used. Try again.' });
    }
    console.error(logLabel, error);
    return res.status(error.statusCode || 500).json({
        message: error.message || 'Failed to save the salary slot.',
    });
}

const SLOT_EXCEL_STATUSES = new Set(['pending_wps', 'pending_update', 'approved']);

/**
 * GET /api/Employee/salary-register/:monthKey/payments/:paymentId/excel
 * The WPS or cash workbook Accounts receives after HR approves the slot.
 */
export const downloadSalarySlotExcel = async (req, res) => {
    try {
        const monthKey = toYearMonth(req.params.monthKey);
        const paymentId = String(req.params.paymentId || '').trim();
        if (!monthKey || !mongoose.Types.ObjectId.isValid(paymentId)) {
            return res.status(400).json({ message: 'Invalid salary slot.' });
        }
        const doc = await SalaryMonthPayment.findOne({ _id: paymentId, monthKey });
        if (!doc || slotStatusOf(doc) === 'cancelled') {
            return res.status(404).json({ message: 'Salary slot was not found.' });
        }
        if (!SLOT_EXCEL_STATUSES.has(slotStatusOf(doc))) {
            return res.status(400).json({ message: 'The Excel is available after HR approves the slot.' });
        }
        const file = await buildSalarySlotFile(doc);
        res.setHeader('Content-Type', file.contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${String(file.filename).replace(/"/g, '')}"`);
        return res.send(file.content);
    } catch (error) {
        console.error('[downloadSalarySlotExcel]', error);
        return res.status(500).json({ message: 'Could not build the salary Excel.' });
    }
};

/**
 * POST /api/Employee/salary-register/:monthKey/payments
 * Accounts saves a draft slot or applies it to HR. One company, one pay type.
 */
export const createSalaryMonthPayment = async (req, res) => {
    try {
        const monthKey = toYearMonth(req.params.monthKey || req.body?.monthKey);
        if (!monthKey) return res.status(400).json({ message: 'Invalid salary month.' });
        const action = String(req.body?.action || '').trim().toLowerCase();
        if (action !== 'draft' && action !== 'apply') {
            return res.status(400).json({ message: 'Choose draft or apply.' });
        }

        await assertMonthReadyForSlots(monthKey);
        await assertZohoJournalUpdated(monthKey);
        const slotCtx = await buildDmfViewerContext(req);
        if (!slotCtx?.isAccounts) {
            return res.status(403).json({
                message: 'Only the flowchart Accounts assignee can create a salary slot.',
            });
        }

        const prepared = await prepareSlotSelection({
            monthKey,
            requested: slotRequestIds(req.body),
            companyName: req.body?.companyName,
        });
        const createdByRaw = req.user?.id || req.user?._id;
        const createdBy =
            createdByRaw && mongoose.Types.ObjectId.isValid(createdByRaw) ? createdByRaw : null;
        const doc = await SalaryMonthPayment.create({
            monthKey,
            paymentNo: prepared.lastNo + 1,
            employeeIds: prepared.employeeIds,
            companyName: prepared.companyName,
            paymentMethod: prepared.paymentMethod,
            status: action === 'apply' ? 'pending_hr' : 'draft',
            rejectReason: '',
            createdBy,
        });
        if (action === 'apply') {
            await mailSlotHr(req, monthKey, doc.paymentNo);
            await notifyHrSalarySlot({ payment: doc, monthKey });
        }
        return res.status(201).json({
            message: action === 'apply' ? 'Slot sent to HR.' : 'Slot saved as draft.',
            payment: await serializeMonthPaymentWithName(doc),
        });
    } catch (error) {
        return slotErrorResponse(res, error, '[createSalaryMonthPayment]');
    }
};

/**
 * POST /api/Employee/salary-register/:monthKey/payments/:paymentId
 * Accounts can draft, apply, or cancel. Flowchart HR can approve or reject a pending slot.
 */
export const updateSalaryMonthPayment = async (req, res) => {
    try {
        const monthKey = toYearMonth(req.params.monthKey || req.body?.monthKey);
        const paymentId = String(req.params.paymentId || '').trim();
        if (!monthKey || !mongoose.Types.ObjectId.isValid(paymentId)) {
            return res.status(400).json({ message: 'Invalid salary slot.' });
        }
        const action = String(req.body?.action || '').trim().toLowerCase();
        const doc = await SalaryMonthPayment.findOne({ _id: paymentId, monthKey });
        if (!doc) return res.status(404).json({ message: 'Salary slot was not found.' });

        const status = slotStatusOf(doc);
        if (action === 'approve' || action === 'reject') {
            if (status !== 'pending_hr') {
                return res.status(400).json({ message: 'This slot is not pending with HR.' });
            }
            if (!(await viewerIsFlowchartHrAssignee(req))) {
                return res.status(403).json({ message: 'Only the flowchart HR assignee can decide this slot.' });
            }
            if (action === 'reject') {
                const reason = String(req.body?.reason || req.body?.comment || '').trim();
                if (!reason) return res.status(400).json({ message: 'Enter a rejection reason.' });
                doc.status = 'rejected';
                doc.rejectReason = reason;
                await doc.save();
                await closeAccountsSalarySlotInbox(doc._id);
                await mailSlotAccounts(req, monthKey, doc.paymentNo, reason);
                return res.status(200).json({
                    message: 'Slot rejected.',
                    payment: await serializeMonthPaymentWithName(doc),
                });
            }
            const requested = slotRequestIds(req.body);
            if (requested.length) {
                const prepared = await prepareSlotSelection({
                    monthKey,
                    requested,
                    companyName: doc.companyName,
                    ignorePaymentId: doc._id,
                });
                const createdMethod = String(doc.paymentMethod || '').trim();
                if (createdMethod && prepared.paymentMethod !== createdMethod) {
                    return res.status(400).json({
                        message: `This slot stays ${createdMethod}.`,
                    });
                }
                doc.employeeIds = prepared.employeeIds;
                doc.companyName = prepared.companyName;
                doc.paymentMethod = prepared.paymentMethod || doc.paymentMethod;
            }
            const method = String(doc.paymentMethod || '').trim().toUpperCase() === 'CASH' ? 'Cash' : 'WPS';
            doc.status = method === 'Cash' ? 'pending_update' : 'pending_wps';
            doc.rejectReason = '';
            await doc.save();
            await mailSlotAccountsNext(req, monthKey, doc);
            await notifyAccountsSalarySlot({ payment: doc, monthKey });
            return res.status(200).json({
                message: method === 'Cash' ? 'Slot approved. Accounts can update it.' : 'Slot approved. Accounts can check the WPS send.',
                payment: await serializeMonthPaymentWithName(doc),
            });
        }

        if (action === 'wps_updated' || action === 'set_updated') {
            await assertMonthReadyForSlots(monthKey);
            const slotCtx = await buildDmfViewerContext(req);
            if (!slotCtx?.isAccounts) {
                return res.status(403).json({
                    message: 'Only the flowchart Accounts assignee can update this slot.',
                });
            }
            if (action === 'wps_updated') {
                if (status !== 'pending_wps') {
                    return res.status(400).json({ message: 'This slot is not waiting for the WPS send.' });
                }
                doc.status = 'pending_update';
                await doc.save();
                await notifyAccountsSalarySlot({ payment: doc, monthKey, phase: 'update' });
                return res.status(200).json({
                    message: 'WPS updated.',
                    payment: await serializeMonthPaymentWithName(doc),
                });
            }
            if (status !== 'pending_update') {
                return res.status(400).json({ message: 'This slot is not ready to mark as updated.' });
            }
            doc.status = 'approved';
            doc.rejectReason = '';
            await doc.save();
            await applyApprovedSlotSideEffects(doc.employeeIds || [], monthKey);
            await closeAccountsSalarySlotInbox(doc._id);
            return res.status(200).json({
                message: 'Slot updated. Zoho implementation is not done yet.',
                payment: await serializeMonthPaymentWithName(doc),
            });
        }

        if (action !== 'draft' && action !== 'apply' && action !== 'cancel') {
            return res.status(400).json({ message: 'Choose draft, apply, or cancel.' });
        }
        await assertMonthReadyForSlots(monthKey);
        const slotCtx = await buildDmfViewerContext(req);
        if (!slotCtx?.isAccounts) {
            return res.status(403).json({
                message: 'Only the flowchart Accounts assignee can change this salary slot.',
            });
        }
        if (status !== 'draft' && status !== 'rejected') {
            return res.status(400).json({ message: 'This slot can no longer be changed by Accounts.' });
        }
        if (action === 'cancel') {
            doc.status = 'cancelled';
            await doc.save();
            return res.status(200).json({
                message: 'Slot cancelled.',
                payment: await serializeMonthPaymentWithName(doc),
            });
        }

        const prepared = await prepareSlotSelection({
            monthKey,
            requested: slotRequestIds(req.body),
            companyName: req.body?.companyName,
            ignorePaymentId: doc._id,
        });
        doc.employeeIds = prepared.employeeIds;
        doc.companyName = prepared.companyName;
        doc.paymentMethod = prepared.paymentMethod;
        doc.status = action === 'apply' ? 'pending_hr' : 'draft';
        doc.rejectReason = '';
        await doc.save();
        if (action === 'apply') {
            await mailSlotHr(req, monthKey, doc.paymentNo);
            await notifyHrSalarySlot({ payment: doc, monthKey });
        }
        return res.status(200).json({
            message: action === 'apply' ? 'Slot sent to HR.' : 'Slot saved as draft.',
            payment: await serializeMonthPaymentWithName(doc),
        });
    } catch (error) {
        return slotErrorResponse(res, error, '[updateSalaryMonthPayment]');
    }
};
