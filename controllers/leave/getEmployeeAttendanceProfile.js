import mongoose from 'mongoose';
import Attendance from '../../models/Attendance.js';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import EmployeePersonal from '../../models/EmployeePersonal.js';
import PayrollSettings from '../../models/PayrollSettings.js';
import Loan from '../../models/Loan.js';
import Reward from '../../models/Reward.js';
import Fine from '../../models/Fine.js';
import AssetItem from '../../models/AssetItem.js';
import EmployeeSalary from '../../models/EmployeeSalary.js';
import UtilityBillPayment from '../../models/UtilityBillPayment.js';
import { isCompanyShellEmployee } from '../../utils/attendanceEmployeeFilters.js';
import { resolveEmployeeFinePayableAmount } from '../../utils/finePayableAmount.js';
import { normalizeStaffTypeKey } from '../../utils/workLocationHelpers.js';
import {
    getScheduledEmailTimeZone,
    getZonedParts,
} from '../../utils/scheduleDailyAtMidnight.js';
import { hasPermission } from '../../services/permissionService.js';
import { isReqUserSystemSuperUser } from '../../utils/systemSuperUser.js';
import { signOrKeepAttachmentUrl } from '../../utils/s3Upload.js';

const ANNUAL_LEAVE_DAYS = 30;
const SICK_LEAVE_DAYS = 15;

const LEAVE_STATUS_KEYS = new Set([
    'on_leave',
    'sick_leave',
    'compoff_leave',
    'authorized_leave',
    'unauthorized_leave',
    'late_arrived',
    'early_go',
    'mispunch',
]);

const STATUS_LABELS = {
    on_leave: 'Annual leave',
    sick_leave: 'Sick leave',
    compoff_leave: 'Comp off leave',
    authorized_leave: 'Authorized leave',
    unauthorized_leave: 'Unauthorized leave',
    late_arrived: 'Late arrival',
    early_go: 'Early go',
    mispunch: 'Mispunch',
    on_office: 'Present',
    work_from_home: 'Work from home',
};

async function resolveViewerEmployee(req) {
    if (req.user?.employeeObjectId) {
        const byOid = await EmployeeBasic.findById(req.user.employeeObjectId)
            .select('_id employeeId')
            .lean();
        if (byOid) return byOid;
    }
    if (req.user?.employeeId) {
        return EmployeeBasic.findOne({ employeeId: req.user.employeeId })
            .select('_id employeeId')
            .lean();
    }
    return null;
}

async function canViewHrProfile(req) {
    if (await isReqUserSystemSuperUser(req.user)) return true;
    const userId = req.user?.id;
    if (!userId) return false;
    return (
        (await hasPermission(userId, 'hrm_leave', 'view')) ||
        (await hasPermission(userId, 'hrm_attendance', 'view'))
    );
}

export async function canAccessEmployeeAttendanceProfile(req, targetMongoId) {
    if (await canViewHrProfile(req)) return true;
    const viewer = await resolveViewerEmployee(req);
    if (!viewer?._id) return false;
    const target = await EmployeeBasic.findById(targetMongoId).select('primaryReportee').lean();
    if (!target?.primaryReportee) return false;
    return String(target.primaryReportee) === String(viewer._id);
}

function employeeName(emp) {
    return [emp?.firstName, emp?.lastName].filter(Boolean).join(' ').trim();
}

function pad2(value) {
    return String(value).padStart(2, '0');
}

function toDateKey(value) {
    if (!value) return '';
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function formatDayMonthLong(dateKey) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return '';
    const [year, month, day] = dateKey.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        timeZone: 'UTC',
    });
}

function formatDayMonthShort(dateKey) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return '';
    const [year, month, day] = dateKey.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
    });
}

function isLeapYear(year) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function nextBirthdayDateKey(dobKey, dubai) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dobKey)) return '';
    const [, month, rawDay] = dobKey.split('-').map(Number);
    const dayForYear = (year) => (month === 2 && rawDay === 29 && !isLeapYear(year) ? 28 : rawDay);
    const todayKey = `${dubai.year}-${pad2(dubai.month)}-${pad2(dubai.day)}`;
    let year = dubai.year;
    let key = `${year}-${pad2(month)}-${pad2(dayForYear(year))}`;
    if (key < todayKey) {
        year += 1;
        key = `${year}-${pad2(month)}-${pad2(dayForYear(year))}`;
    }
    return key;
}

function yearsOfServiceLabel(joinKey, dubai) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(joinKey)) return '';
    const [joinYear, joinMonth, joinDay] = joinKey.split('-').map(Number);
    let months = (dubai.year - joinYear) * 12 + (dubai.month - joinMonth);
    if (dubai.day < joinDay) months -= 1;
    if (months < 0) months = 0;
    const years = Math.floor(months / 12);
    const rest = months % 12;
    const yearText = years === 1 ? '1 year' : `${years} years`;
    const monthText = rest === 1 ? '1 month' : `${rest} months`;
    if (years === 0) return monthText;
    if (rest === 0) return yearText;
    return `${yearText}, ${monthText}`;
}

function emptyAppliedCounts() {
    return {
        on_leave: 0,
        sick_leave: 0,
        compoff_leave: 0,
        authorized_leave: 0,
        unauthorized_leave: 0,
        late_arrived: 0,
        early_go: 0,
        mispunch: 0,
        work_from_home: 0,
    };
}

function requestedCountKey(row) {
    const kind = String(row?.leaveRequestKind || '').trim();
    if (kind === 'future_annual') return 'on_leave';
    if (kind === 'future_late') return 'late_arrived';
    if (kind === 'future_early') return 'early_go';
    if (kind === 'yellow') {
        const requested = String(row?.requestedStatusKey || '').trim();
        if (requested === 'early_go') return 'early_go';
        if (requested === 'mispunch') return 'mispunch';
        return 'late_arrived';
    }
    const requested = String(row?.requestedStatusKey || '').trim();
    if (requested && Object.prototype.hasOwnProperty.call(emptyAppliedCounts(), requested)) {
        return requested;
    }
    const status = String(row?.statusKey || '').trim();
    if (status && Object.prototype.hasOwnProperty.call(emptyAppliedCounts(), status)) return status;
    return '';
}

async function findNextBirthday(dubai) {
    const [personals, basics] = await Promise.all([
        EmployeePersonal.find({ dateOfBirth: { $exists: true, $ne: null } })
            .select('employeeId dateOfBirth')
            .lean(),
        EmployeeBasic.find({ status: { $ne: 'Left User' } })
            .select('employeeId firstName lastName')
            .lean(),
    ]);
    const byCode = new Map(
        (basics || []).map((row) => [String(row.employeeId || '').trim(), row]),
    );
    const upcoming = (personals || [])
        .map((row) => {
            const emp = byCode.get(String(row.employeeId || '').trim());
            if (!emp) return null;
            const dobKey = toDateKey(row.dateOfBirth);
            const nextKey = nextBirthdayDateKey(dobKey, dubai);
            if (!nextKey) return null;
            return {
                name: employeeName(emp) || emp.employeeId,
                dateKey: nextKey,
                dateLabel: formatDayMonthShort(nextKey),
            };
        })
        .filter(Boolean)
        .sort((a, b) => String(a.dateKey).localeCompare(String(b.dateKey)));
    const next = upcoming[0];
    if (!next) return null;
    return { name: next.name, dateLabel: next.dateLabel, dateKey: next.dateKey };
}

function nextDateKey(dateKey) {
    const [y, m, d] = String(dateKey).split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + 1, 12, 0, 0));
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function daysBetweenInclusive(from, to) {
    if (!from || !to || to < from) return 0;
    let count = 0;
    for (let c = from; c <= to; c = nextDateKey(c)) count += 1;
    return count;
}

function formatDayMonthYear(dateKey) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return '';
    const [year, month, day] = dateKey.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
    });
}

function formatMonthYear(dateKey) {
    if (/^\d{4}-\d{2}$/.test(dateKey)) {
        const [year, month] = dateKey.split('-').map(Number);
        return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-GB', {
            month: 'long',
            year: 'numeric',
            timeZone: 'UTC',
        });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return '';
    const [year, month] = dateKey.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-GB', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
    });
}

function daysAgoLabel(fromKey, todayKey) {
    const days = daysBetweenInclusive(fromKey, todayKey) - 1;
    if (days <= 0) return 'Today';
    if (days === 1) return '1 day';
    return `${days} days`;
}

function daysAgoCount(fromKey, todayKey) {
    return Math.max(0, daysBetweenInclusive(fromKey, todayKey) - 1);
}

function formatShortRange(fromKey, toKey) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromKey)) return '';
    const [year, month, fromDay] = fromKey.split('-').map(Number);
    const monthLabel = new Date(Date.UTC(year, month - 1, fromDay)).toLocaleDateString('en-GB', {
        month: 'short',
        timeZone: 'UTC',
    });
    if (!toKey || toKey === fromKey || !/^\d{4}-\d{2}-\d{2}$/.test(toKey)) {
        return `${fromDay} ${monthLabel}`;
    }
    const toDay = Number(toKey.slice(8, 10));
    const days = daysBetweenInclusive(fromKey, toKey);
    return `${fromDay}-${toDay} ${monthLabel} - ${days} day${days === 1 ? '' : 's'}`;
}

function pendingRequestTitle(appliedKey, kind) {
    if (appliedKey === 'on_leave') return 'Annual leave request';
    if (appliedKey === 'mispunch') return 'Miss punch regularization';
    if (appliedKey === 'authorized_leave') return 'Authorized leave request';
    if (appliedKey === 'sick_leave') return 'Sick leave request';
    if (appliedKey === 'early_go') return 'Early go request';
    if (appliedKey === 'late_arrived') return 'Late arrival request';
    if (appliedKey === 'compoff_leave') return 'Comp off request';
    if (kind === 'yellow') return 'Miss punch regularization';
    const label = STATUS_LABELS[appliedKey] || 'HR request';
    return /request$/i.test(label) ? label : `${label} request`;
}

function pendingRequestSubtitle(row) {
    if (row.appliedKey === 'mispunch') {
        const day = formatShortRange(row.fromDate, row.fromDate);
        return `${day} - Check-out`;
    }
    if (row.fromDate && row.toDate && row.fromDate !== row.toDate) {
        return formatShortRange(row.fromDate, row.toDate);
    }
    return formatShortRange(row.fromDate, row.fromDate) || 'Awaiting approval';
}

function taskAgingBuckets(items) {
    const counts = [0, 0, 0, 0, 0];
    for (const item of items) {
        const days = Number(item.daysAgo) || 0;
        if (days <= 7) counts[0] += 1;
        else if (days <= 10) counts[1] += 1;
        else if (days <= 20) counts[2] += 1;
        else if (days <= 30) counts[3] += 1;
        else counts[4] += 1;
    }
    return [
        { label: '1 week', count: counts[0], color: '#22C55E' },
        { label: '10 days', count: counts[1], color: '#6366F1' },
        { label: '20 days', count: counts[2], color: '#F59E0B' },
        { label: '30 days', count: counts[3], color: '#FB923C' },
        { label: 'More', count: counts[4], color: '#EF4444' },
    ];
}

function pickSalary(salaryDoc) {
    const extra = (salaryDoc?.additionalAllowances || []).reduce(
        (sum, row) => sum + (Number(row?.amount) || 0),
        0,
    );
    const basic = Number(salaryDoc?.basic ?? salaryDoc?.basicSalary) || 0;
    const monthly = Number(salaryDoc?.monthlySalary) || Number(salaryDoc?.totalSalary) || 0;
    const otherFromParts =
        (Number(salaryDoc?.houseRentAllowance) || 0) +
        (Number(salaryDoc?.otherAllowance) || 0) +
        extra;
    const other = monthly > 0 ? Math.max(0, roundMoney(monthly - basic)) : roundMoney(otherFromParts);
    return {
        basic: roundMoney(basic),
        other,
        monthlySalary: roundMoney(monthly),
        totalSalary: roundMoney(Number(salaryDoc?.totalSalary) || monthly),
    };
}

function pickLatestIncrement(history) {
    if (!Array.isArray(history) || history.length < 2) return null;
    const sorted = [...history].sort((a, b) => {
        const aKey = toDateKey(a?.fromDate) || String(a?.month || '');
        const bKey = toDateKey(b?.fromDate) || String(b?.month || '');
        return aKey.localeCompare(bKey);
    });
    const current = sorted[sorted.length - 1];
    const previous = sorted[sorted.length - 2];
    const amount = roundMoney(
        (Number(current?.totalSalary) || 0) - (Number(previous?.totalSalary) || 0),
    );
    if (amount <= 0) return null;
    const dateKey = toDateKey(current?.fromDate);
    return {
        amount,
        dateKey,
        dateLabel: formatDayMonthYear(dateKey) || String(current?.month || '').trim(),
    };
}

function roundMoney(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
}

function remainingLoanPayments(item, outstanding, total) {
    const duration = Math.max(1, Number(item.originalDuration || item.duration) || 1);
    if (outstanding <= 0.01) return 0;
    const monthly = total / duration;
    if (monthly <= 0.01) return duration;
    return Math.min(duration, Math.max(1, Math.ceil(outstanding / monthly - 1e-6)));
}

/** Employee recovery paid vs loan/advance principal — not Zoho disbursement fields. */
function mapLoanFinancialItem(item) {
    const total = roundMoney(item.amount);
    const repaid = roundMoney(item.repaidAmount ?? item.paidAmount);
    const paid = roundMoney(item.paidAmount);
    const outstanding = Math.max(0, roundMoney(total - repaid));
    return {
        id: String(item._id),
        code: item.loanId || (item.type === 'Advance' ? 'Advance' : 'Loan'),
        reason: String(item.reason || '').trim(),
        total,
        paid,
        outstanding,
        remainingPayments: remainingLoanPayments(item, outstanding, total),
        status: item.approvalStatus || item.status || '',
    };
}

/** Employee payable share and employee-side recovery — not vendor/Zoho bill totals. */
function mapFineFinancialItem(item, employeeCode) {
    const total = roundMoney(resolveEmployeeFinePayableAmount(item, employeeCode));
    if (total <= 0) return null;

    const entry = (item.assignedEmployees || []).find((ae) => ae.employeeId === employeeCode);
    const paidRaw = parseFloat(entry?.paidAmount ?? item.paidAmount ?? 0) || 0;
    const paid = roundMoney(Math.min(paidRaw, total));

    return {
        id: String(item._id),
        code: item.fineId || 'Fine',
        type: item.fineType || item.subCategory || item.category || 'Fine',
        total,
        paid,
        outstanding: Math.max(0, roundMoney(total - paid)),
        status: item.fineStatus || '',
    };
}

function mapUtilityExcess(bills) {
    let outstanding = 0;
    let latest = null;
    for (const bill of bills || []) {
        const status = String(bill?.status || '');
        if (status === 'Paid' || status === 'Rejected') continue;
        const excess = Number(bill?.employeeDiffAmount);
        const pay = Number(bill?.employeePayAmount);
        const amount =
            Number.isFinite(excess) && excess > 0.009
                ? excess
                : Number.isFinite(pay) && pay > 0.009
                  ? pay
                  : 0;
        if (amount <= 0.009) continue;
        outstanding += amount;
        if (!latest) latest = bill;
    }
    return {
        outstanding: roundMoney(outstanding),
        utilityType: String(latest?.utilityType || '').trim(),
        billMonth: String(latest?.billMonth || '').trim(),
        billMonthLabel: formatMonthYear(String(latest?.billMonth || '').trim()),
    };
}

/**
 * GET /api/Leave/employees/:id/attendance-profile/access
 */
export async function getEmployeeAttendanceProfileAccess(req, res) {
    try {
        const id = String(req.params.id || '').trim();
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: 'Invalid employee id.' });
        }
        const allowed = await canAccessEmployeeAttendanceProfile(req, id);
        return res.status(200).json({ canAccess: allowed });
    } catch (error) {
        console.error('[getEmployeeAttendanceProfileAccess]', error);
        return res.status(500).json({ message: error.message || 'Failed to check access.' });
    }
}

/**
 * GET /api/Leave/employees/:id/attendance-profile
 */
export async function getEmployeeAttendanceProfile(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const id = String(req.params.id || '').trim();
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: 'Invalid employee id.' });
        }

        const allowed = await canAccessEmployeeAttendanceProfile(req, id);
        if (!allowed) {
            return res.status(403).json({ message: 'Only HR or the primary reportee can view this profile.' });
        }

        const dubai = getZonedParts(new Date(), getScheduledEmailTimeZone());
        const year = Number(req.query.year) || dubai.year;
        const from = `${year}-01-01`;
        const to = `${year}-12-31`;
        const todayKey = `${dubai.year}-${String(dubai.month).padStart(2, '0')}-${String(dubai.day).padStart(2, '0')}`;

        const employee = await EmployeeBasic.findById(id)
            .select(
                '_id employeeId firstName lastName staffType profilePicture salary salaryDetails dateOfJoining joiningDate designation role department status profileStatus primaryReportee',
            )
            .populate('primaryReportee', 'firstName lastName employeeId')
            .lean();
        if (!employee || isCompanyShellEmployee(employee)) {
            return res.status(404).json({ message: 'Employee not found.' });
        }

        const employeeMongoId = String(employee._id);
        const employeeCode = String(employee.employeeId || '').trim();
        const staffType = normalizeStaffTypeKey(employee.staffType) || 'office';

        const [records, loans, rewards, fines, assets, personal, payrollGroup, payrollDefault, nextBirthday, salaryDoc, utilityBills] =
            await Promise.all([
            Attendance.find({ employeeMongoId, date: { $gte: from, $lte: to } })
                .select(
                    'date statusKey statusLabel reason attachmentName leavePayType leaveRequestReason leaveRequestStatus requestedStatusKey requestedStatusLabel leaveRequestKind leaveRequestGroupId leaveRequestFromDate leaveRequestToDate leaveRequestedAt leaveRequestTimeOut',
                )
                .sort({ date: -1 })
                .lean(),
            Loan.find({
                $or: [{ employeeObjectId: employee._id }, { employeeId: employeeCode }],
                status: { $ne: 'Draft' },
            })
                .select('type loanId amount paidAmount repaidAmount duration originalDuration reason status approvalStatus createdAt')
                .sort({ createdAt: -1 })
                .limit(20)
                .lean(),
            Reward.find({ employeeId: employeeCode, rewardStatus: { $ne: 'Draft' } })
                .select('rewardId rewardType amount rewardStatus awardedDate createdAt')
                .sort({ createdAt: -1 })
                .limit(20)
                .lean(),
            Fine.find({ 'assignedEmployees.employeeId': employeeCode, fineStatus: { $ne: 'Draft' } })
                .select(
                    'fineId fineType fineStatus responsibleFor fineAmount totalFineAmount employeeAmount companyAmount serviceCharge discount isGroupView assignedEmployees paidAmount',
                )
                .sort({ createdAt: -1 })
                .limit(20)
                .lean(),
            AssetItem.find({
                assignedTo: employee._id,
                status: { $nin: ['Draft', 'Rejected', 'Returned', 'End of Life', 'Unassigned'] },
            })
                .select('assetId name status plateNumber')
                .sort({ updatedAt: -1 })
                .limit(30)
                .lean(),
            EmployeePersonal.findOne({ employeeId: employeeCode }).select('dateOfBirth').lean(),
            PayrollSettings.findOne({ key: `group:${staffType}` }).lean(),
            PayrollSettings.findOne({ key: 'default' }).lean(),
            findNextBirthday(dubai),
            EmployeeSalary.findOne({ employeeId: employeeCode })
                .select(
                    '-offerLetter.data -salaryHistory.attachment.data -salaryHistory.offerLetter.data -salaryHistory.attachment.url -salaryHistory.offerLetter.url',
                )
                .lean(),
            UtilityBillPayment.find({
                payByEmployeeId: employeeCode,
                status: { $nin: ['Rejected'] },
            })
                .select(
                    'utilityType billMonth employeePayAmount employeeDiffAmount differenceAmount paymentBy status createdAt',
                )
                .sort({ createdAt: -1 })
                .limit(30)
                .lean(),
        ]);

        const counts = {
            on_leave: 0,
            sick_leave: 0,
            compoff_leave: 0,
            authorized_leave: 0,
            unauthorized_leave: 0,
            late_arrived: 0,
            early_go: 0,
            mispunch: 0,
            on_office: 0,
            work_from_home: 0,
            authorized_leave_paid: 0,
            authorized_leave_unpaid: 0,
        };

        const events = [];
        const appliedCounts = emptyAppliedCounts();
        const appliedGroups = new Set();
        const pendingRequestMap = new Map();
        let lastAnnualLeaveDate = '';

        for (const row of records || []) {
            const key = String(row.statusKey || '').trim();
            if (counts[key] != null) counts[key] += 1;
            if (key === 'authorized_leave') {
                const pay = String(row.leavePayType || '').toLowerCase();
                if (pay === 'paid') counts.authorized_leave_paid += 1;
                else if (pay === 'unpaid') counts.authorized_leave_unpaid += 1;
            }
            if (key === 'on_leave' && row.date > lastAnnualLeaveDate) {
                lastAnnualLeaveDate = row.date;
            }
            if (String(row.leaveRequestStatus || '').trim() === 'pending') {
                const appliedKey = requestedCountKey(row);
                const groupId =
                    String(row.leaveRequestGroupId || '').trim() ||
                    `${row.date}-${appliedKey || key}`;
                if (appliedKey && !appliedGroups.has(groupId)) {
                    appliedGroups.add(groupId);
                    appliedCounts[appliedKey] += 1;
                }
                const existing = pendingRequestMap.get(groupId);
                const fromDate = row.leaveRequestFromDate || row.date;
                const toDate = row.leaveRequestToDate || row.date;
                const requestedAtKey = toDateKey(row.leaveRequestedAt) || fromDate || row.date;
                if (!existing) {
                    pendingRequestMap.set(groupId, {
                        id: groupId,
                        appliedKey,
                        kind: String(row.leaveRequestKind || ''),
                        timeOut: String(row.leaveRequestTimeOut || '').trim(),
                        fromDate,
                        toDate,
                        requestedAtKey,
                    });
                } else {
                    if (fromDate && (!existing.fromDate || fromDate < existing.fromDate)) {
                        existing.fromDate = fromDate;
                    }
                    if (toDate && (!existing.toDate || toDate > existing.toDate)) {
                        existing.toDate = toDate;
                    }
                    if (requestedAtKey && requestedAtKey < existing.requestedAtKey) {
                        existing.requestedAtKey = requestedAtKey;
                    }
                }
            }
            if (LEAVE_STATUS_KEYS.has(key)) {
                events.push({
                    id: `${row.date}-${key}`,
                    date: row.date,
                    statusKey: key,
                    statusLabel: row.statusLabel || STATUS_LABELS[key] || key,
                    reason: String(row.reason || row.leaveRequestReason || '').trim(),
                    attachmentName: String(row.attachmentName || '').trim(),
                    leavePayType: String(row.leavePayType || '').trim(),
                });
            }
        }

        const presentDays =
            counts.on_office +
            counts.work_from_home +
            counts.late_arrived +
            counts.early_go +
            counts.mispunch;

        const pieFrom = lastAnnualLeaveDate || from;
        const pieTo = todayKey > to ? to : todayKey;
        const periodDays = daysBetweenInclusive(pieFrom, pieTo);

        const periodRecords = (records || []).filter((r) => r.date >= pieFrom && r.date <= pieTo);
        let periodPresent = 0;
        let periodAnnual = 0;
        let periodOtherLeave = 0;
        for (const row of periodRecords) {
            const key = String(row.statusKey || '');
            if (['on_office', 'work_from_home', 'late_arrived', 'early_go', 'mispunch'].includes(key)) {
                periodPresent += 1;
            } else if (key === 'on_leave') periodAnnual += 1;
            else if (LEAVE_STATUS_KEYS.has(key)) periodOtherLeave += 1;
        }
        const periodRest = Math.max(0, periodDays - periodPresent - periodAnnual - periodOtherLeave);

        const policy = payrollGroup || payrollDefault || {};
        const requiredPresentDays =
            Number(policy.workingDaysRequiredToEligible) > 0
                ? Number(policy.workingDaysRequiredToEligible)
                : 300;
        const airTicketRequiredDays =
            Number(policy.workingDaysRequiredForAirTicket) > 0
                ? Number(policy.workingDaysRequiredForAirTicket)
                : requiredPresentDays;
        const annualEligible = presentDays >= requiredPresentDays;
        const annualTaken = counts.on_leave || 0;
        const annualRemaining = Math.max(0, ANNUAL_LEAVE_DAYS - annualTaken);
        const sickRemaining = Math.max(0, SICK_LEAVE_DAYS - (counts.sick_leave || 0));
        const joinKey = toDateKey(employee.dateOfJoining || employee.joiningDate);
        const dobKey = toDateKey(personal?.dateOfBirth);
        const isActive =
            String(employee.status || '') !== 'Left User' &&
            String(employee.profileStatus || '').toLowerCase() !== 'inactive';
        const reportsTo = employeeName(employee.primaryReportee);

        const loanItems = (loans || []).filter((l) => l.type === 'Loan');
        const advanceItems = (loans || []).filter((l) => l.type === 'Advance');
        const salary = pickSalary(salaryDoc);
        const increment = pickLatestIncrement(salaryDoc?.salaryHistory);
        const utility = mapUtilityExcess(utilityBills);
        const pendingHrRequests = [...pendingRequestMap.values()]
            .sort((a, b) => String(b.requestedAtKey).localeCompare(String(a.requestedAtKey)))
            .map((row) => ({
                id: row.id,
                title: pendingRequestTitle(row.appliedKey, row.kind),
                subtitle: pendingRequestSubtitle(row),
                badge: daysAgoLabel(row.requestedAtKey, todayKey),
                daysAgo: daysAgoCount(row.requestedAtKey, todayKey),
            }));
        for (const bill of utilityBills || []) {
            const status = String(bill.status || '');
            if (status !== 'Pending HR' && status !== 'Pending Accounts') continue;
            const createdKey = toDateKey(bill.createdAt);
            pendingHrRequests.push({
                id: `utility-${bill._id}`,
                title: 'Utility bill clarification',
                subtitle: [bill.utilityType, formatMonthYear(String(bill.billMonth || '').trim())]
                    .filter(Boolean)
                    .join(' - ') || 'Utility bill',
                badge: daysAgoLabel(createdKey, todayKey),
                daysAgo: daysAgoCount(createdKey, todayKey),
            });
        }
        const rawPhoto = employee.profilePicture || '';
        const profilePicture = rawPhoto.startsWith('data:')
            ? rawPhoto
            : (await signOrKeepAttachmentUrl(rawPhoto)) || rawPhoto;

        return res.status(200).json({
            year,
            employee: {
                _id: employeeMongoId,
                employeeId: employeeCode,
                name: employeeName(employee),
                staffType,
                profilePicture,
                designation: String(employee.designation || employee.role || '').trim(),
                department: String(employee.department || '').trim(),
                status: String(employee.status || '').trim(),
                profileStatus: String(employee.profileStatus || '').trim(),
                isActive,
                dateOfJoining: joinKey,
                dateOfBirth: dobKey,
                birthdayLabel: formatDayMonthLong(dobKey),
                yearsOfServiceLabel: yearsOfServiceLabel(joinKey, dubai),
                reportsTo,
                reportsToEmployeeId: String(employee.primaryReportee?.employeeId || '').trim(),
            },
            nextBirthday,
            summary: {
                presentDays,
                absentDays: counts.authorized_leave + counts.sick_leave + counts.compoff_leave + counts.unauthorized_leave + counts.on_leave,
                counts,
                appliedCounts,
                lastAnnualLeaveDate,
            },
            annualLeave: {
                eligible: annualEligible,
                presentDays,
                requiredPresentDays,
                eligibleDays: ANNUAL_LEAVE_DAYS,
                leaveSalaryDays: annualTaken,
                remainingDays: annualRemaining,
                sickDays: SICK_LEAVE_DAYS,
                sickRemaining,
                airTicketEligible: presentDays >= airTicketRequiredDays,
                airTicketRequiredDays,
                lastAnnualLeaveDate,
                pieFrom,
                pieTo,
                pie: [
                    { key: 'present', label: 'Present', value: periodPresent, color: '#22C55E' },
                    { key: 'annual', label: 'Annual leave', value: periodAnnual, color: '#6366F1' },
                    { key: 'other_leave', label: 'Other leave', value: periodOtherLeave, color: '#F59E0B' },
                    { key: 'other', label: 'Other / off', value: periodRest, color: '#CBD5E1' },
                ].filter((s) => s.value > 0),
            },
            events,
            financial: {
                salary,
                increment,
                loans: loanItems.map(mapLoanFinancialItem),
                advances: advanceItems.map(mapLoanFinancialItem),
                rewards: (rewards || []).map((r) => ({
                    id: String(r._id),
                    code: r.rewardId || 'Reward',
                    type: r.rewardType || 'Reward',
                    amount: Number(r.amount) || 0,
                    status: r.rewardStatus || '',
                    dateLabel: formatMonthYear(toDateKey(r.awardedDate || r.createdAt)),
                })),
                fines: (fines || [])
                    .map((f) => mapFineFinancialItem(f, employeeCode))
                    .filter(Boolean),
                utility,
                assets: (assets || []).map((a) => ({
                    id: String(a._id),
                    code: a.plateNumber || a.assetId || a.name || 'Asset',
                    status: a.status || '',
                })),
            },
            requests: {
                pending: pendingHrRequests,
                hrPendingCount: pendingHrRequests.length,
                workTaskPendingCount: 0,
                workflowActiveIndex: pendingHrRequests.length ? 1 : 3,
                taskAging: taskAgingBuckets(pendingHrRequests),
            },
        });
    } catch (error) {
        console.error('[getEmployeeAttendanceProfile]', error);
        return res.status(500).json({ message: error.message || 'Failed to load attendance profile.' });
    }
}
