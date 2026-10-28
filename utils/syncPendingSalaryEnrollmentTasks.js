import DashboardAction from '../models/DashboardAction.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import SalaryEnrollment from '../models/SalaryEnrollment.js';
import SalaryHistoricalProfile from '../models/SalaryHistoricalProfile.js';
import {
    isCompanyShellEmployee,
    REAL_EMPLOYEE_MONGO_FILTER,
} from './attendanceEmployeeFilters.js';
import { isPlaceholderEmployeeId } from './employeeIdPrefix.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import {
    isPendingEnrollmentReminder,
    PENDING_ENROLLMENT_EXTRA,
    PENDING_ENROLLMENT_REQUEST_TYPE,
} from './pendingEnrollmentReminder.js';

export { isPendingEnrollmentReminder, PENDING_ENROLLMENT_EXTRA, PENDING_ENROLLMENT_REQUEST_TYPE };

const SYNC_GAP_MS = 15000;
let lastSyncAt = 0;
let syncing = null;

function employeeCodeKey(value) {
    return String(value || '')
        .trim()
        .replace(/\s+/g, '')
        .toUpperCase();
}

function employeeName(emp) {
    return `${emp?.firstName || ''} ${emp?.lastName || ''}`.trim() || String(emp?.employeeId || '').trim();
}

function reminderFilter(employeeId) {
    return {
        requestId: employeeId,
        requestType: PENDING_ENROLLMENT_REQUEST_TYPE,
        status: 'Pending',
        $or: [
            { extra2: PENDING_ENROLLMENT_EXTRA },
            { extra3: /"pendingEnrollment"\s*:\s*true/ },
        ],
    };
}

/** Active people who still have no salary enrollment and no open approval task. */
export async function listEmployeesPendingEnrollment() {
    const [employeeRows, enrollmentDocs, profileDocs, approvalRows] = await Promise.all([
        EmployeeBasic.find({
            employeeId: { $nin: ['', 'VEGA-HR-0000'] },
            status: { $ne: 'Left User' },
            ...REAL_EMPLOYEE_MONGO_FILTER,
        })
            .select('_id employeeId firstName lastName status profileStatus')
            .lean()
            .maxTimeMS(12000),
        SalaryEnrollment.find({}).select('employeeId').lean().maxTimeMS(8000),
        SalaryHistoricalProfile.find({ workflowStatus: 'locked' })
            .select('employeeId')
            .lean()
            .maxTimeMS(8000),
        DashboardAction.find({
            requestType: PENDING_ENROLLMENT_REQUEST_TYPE,
            status: 'Pending',
            extra2: { $ne: PENDING_ENROLLMENT_EXTRA },
        })
            .select('subjectEmployeeId extra2 extra3')
            .lean()
            .maxTimeMS(8000),
    ]);

    const covered = new Set();
    for (const row of enrollmentDocs || []) {
        const key = employeeCodeKey(row.employeeId);
        if (key) covered.add(key);
    }
    for (const row of profileDocs || []) {
        const key = employeeCodeKey(row.employeeId);
        if (key) covered.add(key);
    }
    for (const row of approvalRows || []) {
        if (isPendingEnrollmentReminder(row)) continue;
        const meta = (() => {
            try {
                const parsed = JSON.parse(String(row.extra3 || '{}'));
                return parsed && typeof parsed === 'object' ? parsed : {};
            } catch {
                return {};
            }
        })();
        const key = employeeCodeKey(row.subjectEmployeeId || meta.employeeId);
        if (key) covered.add(key);
    }

    const pending = [];
    for (const emp of employeeRows || []) {
        if (!emp?._id || !emp.employeeId || isCompanyShellEmployee(emp) || isPlaceholderEmployeeId(emp.employeeId)) {
            continue;
        }
        if (String(emp.status || '') === 'Left User') continue;
        const profile = String(emp.profileStatus || '').trim().toLowerCase();
        if (profile && profile !== 'active') continue;
        const key = employeeCodeKey(emp.employeeId);
        if (!key || covered.has(key)) continue;
        pending.push(emp);
    }
    return pending;
}

export async function dismissPendingEnrollmentReminder(employeeMongoId) {
    const id = String(employeeMongoId || '').trim();
    if (!/^[a-fA-F0-9]{24}$/.test(id)) return { dismissed: 0 };
    const result = await DashboardAction.updateMany(reminderFilter(id), {
        $set: {
            status: 'Dismissed',
            actionedDate: new Date(),
            comment: 'Closed: enrolment was sent for approval',
        },
    });
    return { dismissed: Number(result?.modifiedCount) || 0 };
}

async function flowchartHrAssignee() {
    const hr = await getDepartmentHOD('hr');
    if (!hr?._id) return null;
    return hr;
}

async function runSync() {
    const hr = await flowchartHrAssignee();
    const pending = await listEmployeesPendingEnrollment();
    const pendingKeys = new Set(pending.map((emp) => employeeCodeKey(emp.employeeId)));

    const openReminders = await DashboardAction.find({
        requestType: PENDING_ENROLLMENT_REQUEST_TYPE,
        status: 'Pending',
        $or: [
            { extra2: PENDING_ENROLLMENT_EXTRA },
            { extra3: /"pendingEnrollment"\s*:\s*true/ },
        ],
    })
        .select('_id subjectEmployeeId')
        .lean()
        .maxTimeMS(8000);

    const staleIds = (openReminders || [])
        .filter((row) => !pendingKeys.has(employeeCodeKey(row.subjectEmployeeId)))
        .map((row) => row._id)
        .filter(Boolean);
    if (staleIds.length) {
        await DashboardAction.updateMany(
            { _id: { $in: staleIds }, status: 'Pending' },
            {
                $set: {
                    status: 'Dismissed',
                    actionedDate: new Date(),
                    comment: 'Closed: employee is enrolled or no longer pending',
                },
            },
        );
    }

    if (!hr || !pending.length) {
        return { ok: true, upserted: 0, dismissed: staleIds.length };
    }

    const now = new Date();
    const ops = pending.map((emp) => {
        const employeeId = String(emp.employeeId).trim();
        const name = employeeName(emp);
        const href = `/HRM/Salary/enroll/${encodeURIComponent(employeeId)}`;
        return {
            updateOne: {
                filter: reminderFilter(emp._id),
                update: {
                    $set: {
                        assignedTo: hr._id,
                        assignedToEmpId: String(hr.employeeId || '').trim(),
                        subjectEmployeeId: employeeId,
                        subjectName: name,
                        requestedByName: 'System',
                        extra1: `${name} is pending for enrollment`,
                        extra2: PENDING_ENROLLMENT_EXTRA,
                        extra3: JSON.stringify({ href, employeeId, pendingEnrollment: true }),
                    },
                    $setOnInsert: {
                        requestId: emp._id,
                        requestType: PENDING_ENROLLMENT_REQUEST_TYPE,
                        status: 'Pending',
                        requestedDate: now,
                    },
                },
                upsert: true,
            },
        };
    });
    if (ops.length) await DashboardAction.bulkWrite(ops, { ordered: false });
    return { ok: true, upserted: ops.length, dismissed: staleIds.length };
}

/** Save one Task Manager row for each employee who is still pending salary enrollment. */
export async function syncPendingSalaryEnrollmentTasks() {
    const now = Date.now();
    if (syncing) return syncing;
    if (now - lastSyncAt < SYNC_GAP_MS) return { ok: true, skipped: true };
    syncing = runSync()
        .then((result) => {
            lastSyncAt = Date.now();
            return result;
        })
        .catch((error) => {
            console.error('[syncPendingSalaryEnrollmentTasks]', error);
            return { ok: false };
        })
        .finally(() => {
            syncing = null;
        });
    return syncing;
}
