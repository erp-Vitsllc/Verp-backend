import EmployeeBasic from '../models/EmployeeBasic.js';
import { isRequestUserDesignatedFlowchartHr } from './isDesignatedFlowchartHr.js';

export const APPROVED_LOAN_STATUSES = ['Approved', 'Paid'];

export function isApprovedLoanStatus(status) {
    return APPROVED_LOAN_STATUSES.includes(status);
}

function collectIdentityIds(user) {
    if (!user) return [];
    return [user._id, user.id, user.employeeObjectId, user.employeeId]
        .filter(Boolean)
        .map(String);
}

function identityMatches(user, target) {
    const userIds = collectIdentityIds(user);
    if (!userIds.length || !target) return false;
    const targetIds =
        typeof target === 'object' ? collectIdentityIds(target) : [String(target)];
    return userIds.some((id) => targetIds.includes(id));
}

export async function isUserHrForApprovedLoanEdit(req, loan) {
    if (!req?.user) return false;

    if (req.user.isAdmin || req.user.role === 'Admin') {
        return true;
    }

    if (await isRequestUserDesignatedFlowchartHr(req)) {
        return true;
    }

    const empId = req.user.employeeId;
    if (empId) {
        const emp = await EmployeeBasic.findOne({ employeeId: empId })
            .select('department designation')
            .lean();
        const dept = (emp?.department || req.user.department || '').toLowerCase();
        const des = (emp?.designation || req.user.designation || '').toLowerCase();
        if (
            dept === 'hr' ||
            dept.includes('human resource') ||
            des.includes('human resource') ||
            /\bhr\b/.test(des)
        ) {
            return true;
        }
    }

    if (loan?.hrApprovedBy && identityMatches(req.user, loan.hrApprovedBy)) {
        return true;
    }

    const hrStep = (loan?.workflow || []).find((w) => w.role === 'HR' || w.role === 'HR Admin');
    if (hrStep?.assignedTo && identityMatches(req.user, hrStep.assignedTo)) {
        return true;
    }

    return false;
}

export function restrictApprovedLoanUpdates(updates = {}, loan) {
    const allowed = {};

    if (updates.monthStart !== undefined) {
        allowed.monthStart = updates.monthStart;
    }

    if (updates.duration !== undefined) {
        const duration = parseInt(updates.duration, 10);
        allowed.duration = Number.isFinite(duration) && duration >= 1
            ? duration
            : (loan?.duration || 1);
    }

    if (Object.keys(allowed).length === 0) {
        return {
            error: 'Approved loans can only be updated for deduction start month and duration.',
            allowed: {},
        };
    }

    return { allowed };
}
