import DashboardAction from '../../models/DashboardAction.js';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import SalaryEnrollment from '../../models/SalaryEnrollment.js';
import SalaryHistoricalProfile from '../../models/SalaryHistoricalProfile.js';
import SalaryMonthDmf from '../../models/SalaryMonthDmf.js';
import { purgeOrphanDashboardActionRows } from '../../utils/clearDashboardActionsForRequest.js';
import {
    isCompanyShellEmployee,
    REAL_EMPLOYEE_MONGO_FILTER,
} from '../../utils/attendanceEmployeeFilters.js';
import { isPlaceholderEmployeeId } from '../../utils/employeeIdPrefix.js';
import { resolveFlowchartHrEmployee } from '../../utils/resolveFlowchartHrEmployee.js';
import {
    buildAssigneeClauses,
    resolveDashboardAssigneeContext,
} from '../../utils/resolveDashboardAssigneeContext.js';
import {
    SALARY_ENROLLMENT_REQUEST_TYPE,
    rewriteSalaryEnrollmentWaitingCopy,
    salaryEnrollmentApproverLabel,
    salaryEnrollmentWaitingMessage,
} from '../../utils/salaryEnrollmentApprovalNotify.js';
import { SALARY_DMF_REQUEST_TYPE } from '../../utils/salaryDmfApproval.js';
import { viewerIsSalaryFlowchartHr } from '../../utils/viewerIsSalaryFlowchartHr.js';

function parseExtra3(value) {
    if (!value) return {};
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(String(value));
    } catch {
        return {};
    }
}

function employeeCodeKey(value) {
    return String(value || '')
        .trim()
        .replace(/\s+/g, '')
        .toUpperCase();
}

function employeeMatchesHr(employee, hrEmployee) {
    if (!employee || !hrEmployee) return false;
    if (employee._id && hrEmployee._id && String(employee._id) === String(hrEmployee._id)) {
        return true;
    }
    const a = employeeCodeKey(employee.employeeId);
    const b = employeeCodeKey(hrEmployee.employeeId);
    return Boolean(a && b && a === b);
}

async function shouldIncludePendingEnrollments(req, ctx) {
    if (ctx?.isTargeted) {
        const hrResolved = await resolveFlowchartHrEmployee();
        if (hrResolved.error || !hrResolved.employee) return false;
        return employeeMatchesHr(ctx.employee, hrResolved.employee);
    }
    return viewerIsSalaryFlowchartHr(req);
}

/** Active employees whose enroll status is still Pending (not enrolled, not waiting HR). */
async function buildPendingEnrollmentInboxItems(excludeEmployeeKeys = new Set()) {
    const [employeeRows, enrollmentDocs, profileDocs] = await Promise.all([
        EmployeeBasic.find({
            employeeId: { $nin: ['', 'VEGA-HR-0000'] },
            status: { $ne: 'Left User' },
            ...REAL_EMPLOYEE_MONGO_FILTER,
        })
            .select('employeeId firstName lastName status profileStatus')
            .lean()
            .maxTimeMS(12000),
        SalaryEnrollment.find({}).select('employeeId').lean().maxTimeMS(8000),
        SalaryHistoricalProfile.find({})
            .select('employeeId workflowStatus')
            .lean()
            .maxTimeMS(8000),
    ]);

    const enrolledKeys = new Set();
    for (const row of enrollmentDocs || []) {
        const key = employeeCodeKey(row.employeeId);
        if (key) enrolledKeys.add(key);
    }
    for (const row of profileDocs || []) {
        const key = employeeCodeKey(row.employeeId);
        if (!key) continue;
        if (String(row.workflowStatus || '') === 'locked') enrolledKeys.add(key);
    }

    const items = [];
    for (const emp of employeeRows || []) {
        if (!emp?.employeeId || isCompanyShellEmployee(emp) || isPlaceholderEmployeeId(emp.employeeId)) {
            continue;
        }
        if (String(emp.status || '') === 'Left User') continue;
        const profile = String(emp.profileStatus || '').trim().toLowerCase();
        if (profile && profile !== 'active') continue;
        const employeeId = String(emp.employeeId).trim();
        const key = employeeCodeKey(employeeId);
        if (!key || enrolledKeys.has(key) || excludeEmployeeKeys.has(key)) {
            continue;
        }
        const name = `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || employeeId;
        const href = `/HRM/Salary/enroll/${encodeURIComponent(employeeId)}`;
        items.push({
            dashboardActionId: `enroll-pending-${employeeId}`,
            requestType: SALARY_ENROLLMENT_REQUEST_TYPE,
            requestedDate: new Date(),
            requestedByName: '',
            subjectName: name,
            subjectEmployeeId: employeeId,
            extra1: `${name} is pending for enrollment`,
            extra2: 'Pending for enrollment',
            extra3: JSON.stringify({ href, employeeId, pendingEnrollment: true }),
            href,
            status: 'Pending',
        });
    }

    items.sort((a, b) =>
        String(a.subjectName).localeCompare(String(b.subjectName), undefined, { sensitivity: 'base' }),
    );
    return items.slice(0, 200);
}

function payrollWaitingCopy(text, type) {
    const raw = String(text || '').trim();
    if (type !== SALARY_DMF_REQUEST_TYPE && !/\bDMF\b/i.test(raw)) return raw;
    return raw
        .replace(/\s*payroll DMF is waiting on\s*/i, ' payroll waiting for ')
        .replace(/\s*DMF is waiting on\s*/i, ' payroll waiting for ')
        .replace(/\bDMF\b/gi, '')
        .replace(/\s{2,}/g, ' ')
        .replace(/\s+\./g, '.')
        .trim();
}

async function resolveEnrollmentApproverLabel() {
    return salaryEnrollmentApproverLabel();
}

function mapDashboardInboxItem(da, profileById, monthDmfById, approverLabel = 'HR') {
    const type = String(da.requestType || SALARY_ENROLLMENT_REQUEST_TYPE);
    const profile = profileById[String(da.requestId)];
    const monthRow = monthDmfById[String(da.requestId)];
    const meta = parseExtra3(da.extra3);
    const employeeId = profile?.employeeId || da.subjectEmployeeId || meta.employeeId || '';
    const monthKey = monthRow?.monthKey || meta.monthKey || '';
    const href =
        meta.href ||
        (type === SALARY_DMF_REQUEST_TYPE && monthKey
            ? `/HRM/Salary/${encodeURIComponent(monthKey)}`
            : employeeId
              ? `/HRM/Salary/enroll/${encodeURIComponent(employeeId)}`
              : '/HRM/Salary');
    const isEnrollment = type === SALARY_ENROLLMENT_REQUEST_TYPE;
    const extra1 = isEnrollment
        ? rewriteSalaryEnrollmentWaitingCopy(da.extra1, approverLabel) ||
          salaryEnrollmentWaitingMessage({
              employeeName: da.subjectName,
              employeeId,
              approverLabel,
          })
        : payrollWaitingCopy(da.extra1, type) || 'Payroll waiting for approval';
    const extra2 = isEnrollment
        ? `Enrolment waiting for ${approverLabel}`
        : da.extra2 === 'DMF approval'
          ? 'Payroll approval'
          : da.extra2 || 'Payroll approval';
    return {
        dashboardActionId: da._id,
        requestType: type,
        requestedDate: da.requestedDate,
        requestedByName: da.requestedByName || '',
        subjectName: da.subjectName || employeeId || monthKey,
        subjectEmployeeId: employeeId,
        extra1,
        extra2,
        extra3: da.extra3 || JSON.stringify({ href, employeeId, monthKey }),
        href,
        status: 'Pending',
    };
}

/**
 * GET /api/Employee/salary-enroll/pending-inbox
 */
export const getPendingSalaryDashboardInbox = async (req, res) => {
    try {
        const ctx = await resolveDashboardAssigneeContext(req);
        if (!ctx.ok) {
            return res.status(ctx.status || 401).json({ message: ctx.message || 'Unauthorized' });
        }

        const assigneeClauses = buildAssigneeClauses(ctx.relevantIds, ctx.employeeIdCode);
        const items = [];

        if (assigneeClauses.length > 0) {
            const rows = await DashboardAction.find({
                status: 'Pending',
                requestType: { $in: [SALARY_ENROLLMENT_REQUEST_TYPE, SALARY_DMF_REQUEST_TYPE] },
                $or: assigneeClauses,
            })
                .sort({ requestedDate: -1 })
                .limit(200)
                .lean();

            const profileIds = [...new Set(rows.map((r) => String(r.requestId)).filter(Boolean))];
            const [profiles, monthDmfs] = await Promise.all([
                profileIds.length
                    ? SalaryHistoricalProfile.find({ _id: { $in: profileIds } })
                          .select('_id employeeId workflowStatus status dmfApproval')
                          .lean()
                    : [],
                profileIds.length
                    ? SalaryMonthDmf.find({ _id: { $in: profileIds } })
                          .select('_id monthKey dmfApproval')
                          .lean()
                    : [],
            ]);
            const profileById = Object.fromEntries(profiles.map((row) => [String(row._id), row]));
            const monthDmfById = Object.fromEntries(monthDmfs.map((row) => [String(row._id), row]));
            const liveById = { ...profileById, ...monthDmfById };
            const liveRows = await purgeOrphanDashboardActionRows(rows, liveById);

            const idsToDismiss = [];
            const actionableRows = [];
            for (const da of liveRows) {
                const type = String(da.requestType || '');
                if (type === SALARY_DMF_REQUEST_TYPE) {
                    const monthRow = monthDmfById[String(da.requestId)];
                    const dmfStatus = String(monthRow?.dmfApproval?.status || '');
                    if (dmfStatus !== 'pending') {
                        if (da._id) idsToDismiss.push(da._id);
                        continue;
                    }
                    actionableRows.push(da);
                    continue;
                }

                const profile = profileById[String(da.requestId)];
                if (String(profile?.workflowStatus || '') !== 'pending_hr') {
                    if (da._id) idsToDismiss.push(da._id);
                    continue;
                }
                actionableRows.push(da);
            }

            if (idsToDismiss.length) {
                await DashboardAction.updateMany(
                    { _id: { $in: idsToDismiss }, status: 'Pending' },
                    {
                        $set: {
                            status: 'Dismissed',
                            actionedDate: new Date(),
                            comment: 'Closed: salary request is no longer waiting',
                        },
                    },
                );
            }

            const approverLabel = await resolveEnrollmentApproverLabel();
            items.push(
                ...actionableRows.map((da) =>
                    mapDashboardInboxItem(da, profileById, monthDmfById, approverLabel),
                ),
            );
        }

        let includePendingEnrollments = false;
        try {
            includePendingEnrollments = await shouldIncludePendingEnrollments(req, ctx);
        } catch {
            includePendingEnrollments = false;
        }
        if (!includePendingEnrollments && items.length > 0) {
            includePendingEnrollments = true;
        }
        if (includePendingEnrollments) {
            const exclude = new Set(items.map((row) => employeeCodeKey(row.subjectEmployeeId)));
            items.push(...(await buildPendingEnrollmentInboxItems(exclude)));
        }

        return res.json({ count: items.length, items });
    } catch (error) {
        console.error('[getPendingSalaryDashboardInbox]', error);
        return res.status(500).json({ message: 'Failed to load salary notifications.' });
    }
};
