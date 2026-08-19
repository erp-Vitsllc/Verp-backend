import mongoose from 'mongoose';
import Attendance from '../../models/Attendance.js';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import Loan from '../../models/Loan.js';
import Reward from '../../models/Reward.js';
import Fine from '../../models/Fine.js';
import AssetItem from '../../models/AssetItem.js';
import { isCompanyShellEmployee } from '../../utils/attendanceEmployeeFilters.js';
import { resolveEmployeeFinePayableAmount } from '../../utils/finePayableAmount.js';
import {
    getScheduledEmailTimeZone,
    getZonedParts,
} from '../../utils/scheduleDailyAtMidnight.js';
import { hasPermission } from '../../services/permissionService.js';
import { isReqUserSystemSuperUser } from '../../utils/systemSuperUser.js';

const LEAVE_STATUS_KEYS = new Set([
    'on_leave',
    'sick_leave',
    'authorized_leave',
    'unauthorized_leave',
    'late_arrived',
    'early_go',
    'mispunch',
]);

const STATUS_LABELS = {
    on_leave: 'Annual leave',
    sick_leave: 'Sick leave',
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

function pickSalary(emp) {
    const salary = emp?.salary || emp?.salaryDetails || {};
    return {
        basic: Number(salary.basic ?? salary.basicSalary) || 0,
        totalSalary: Number(salary.totalSalary) || 0,
        monthlySalary: Number(salary.monthlySalary) || 0,
    };
}

function roundMoney(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
}

/** Employee recovery paid vs loan/advance principal — not Zoho disbursement fields. */
function mapLoanFinancialItem(item) {
    const total = roundMoney(item.amount);
    const paid = roundMoney(item.paidAmount);
    return {
        id: String(item._id),
        code: item.loanId || (item.type === 'Advance' ? 'Advance' : 'Loan'),
        total,
        paid,
        outstanding: Math.max(0, roundMoney(total - paid)),
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
        total,
        paid,
        outstanding: Math.max(0, roundMoney(total - paid)),
        status: item.fineStatus || '',
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
            .select('_id employeeId firstName lastName staffType profilePicture salary salaryDetails dateOfJoining joiningDate')
            .lean();
        if (!employee || isCompanyShellEmployee(employee)) {
            return res.status(404).json({ message: 'Employee not found.' });
        }

        const employeeMongoId = String(employee._id);
        const employeeCode = String(employee.employeeId || '').trim();

        const [records, loans, rewards, fines, assets] = await Promise.all([
            Attendance.find({ employeeMongoId, date: { $gte: from, $lte: to } })
                .select('date statusKey statusLabel reason attachmentName leavePayType leaveRequestReason')
                .sort({ date: -1 })
                .lean(),
            Loan.find({
                $or: [{ employeeObjectId: employee._id }, { employeeId: employeeCode }],
                status: { $ne: 'Draft' },
            })
                .select('type loanId amount paidAmount status approvalStatus createdAt')
                .sort({ createdAt: -1 })
                .limit(20)
                .lean(),
            Reward.find({ employeeId: employeeCode, rewardStatus: { $ne: 'Draft' } })
                .select('rewardId rewardType amount rewardStatus createdAt')
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
        ]);

        const counts = {
            on_leave: 0,
            sick_leave: 0,
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

        const annualEligible = presentDays >= 300;

        const loanItems = (loans || []).filter((l) => l.type === 'Loan');
        const advanceItems = (loans || []).filter((l) => l.type === 'Advance');

        return res.status(200).json({
            year,
            employee: {
                _id: employeeMongoId,
                employeeId: employeeCode,
                name: employeeName(employee),
                staffType: String(employee.staffType || 'office').toLowerCase() === 'site' ? 'site' : 'office',
                profilePicture: employee.profilePicture || '',
            },
            summary: {
                presentDays,
                absentDays: counts.authorized_leave + counts.sick_leave + counts.unauthorized_leave + counts.on_leave,
                counts,
                lastAnnualLeaveDate,
            },
            annualLeave: {
                eligible: annualEligible,
                presentDays,
                requiredPresentDays: 300,
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
                salary: pickSalary(employee),
                loans: loanItems.map(mapLoanFinancialItem),
                advances: advanceItems.map(mapLoanFinancialItem),
                rewards: (rewards || []).map((r) => ({
                    id: String(r._id),
                    code: r.rewardId || 'Reward',
                    type: r.rewardType || 'Reward',
                    amount: Number(r.amount) || 0,
                    status: r.rewardStatus || '',
                })),
                fines: (fines || [])
                    .map((f) => mapFineFinancialItem(f, employeeCode))
                    .filter(Boolean),
                assets: (assets || []).map((a) => ({
                    id: String(a._id),
                    code: a.plateNumber || a.assetId || a.name || 'Asset',
                    status: a.status || '',
                })),
            },
        });
    } catch (error) {
        console.error('[getEmployeeAttendanceProfile]', error);
        return res.status(500).json({ message: error.message || 'Failed to load attendance profile.' });
    }
}
