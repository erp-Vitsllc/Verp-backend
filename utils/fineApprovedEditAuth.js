import EmployeeBasic from '../models/EmployeeBasic.js';
import { isRequestUserDesignatedFlowchartHr } from './isDesignatedFlowchartHr.js';
import { identitiesMatch } from './fineStageAuth.js';

export const APPROVED_FINE_STATUSES = ['Approved', 'Active', 'Paid', 'Completed'];

export function isApprovedFineStatus(status) {
    return APPROVED_FINE_STATUSES.includes(status);
}

export async function isUserHrForApprovedFineEdit(req, fine) {
    if (!req?.user) return false;

    if (await isRequestUserDesignatedFlowchartHr(req)) {
        return true;
    }

    const empId = req.user.employeeId;
    if (empId) {
        const emp = await EmployeeBasic.findOne({ employeeId: empId })
            .select('department designation')
            .lean();
        const dept = (emp?.department || '').toLowerCase();
        const des = (emp?.designation || '').toLowerCase();
        if (
            dept === 'hr' ||
            dept.includes('human resource') ||
            des.includes('human resource') ||
            /\bhr\b/.test(des)
        ) {
            return true;
        }
    }

    if (fine?.hrHODId && req.user.employeeId && String(fine.hrHODId) === String(req.user.employeeId)) {
        return true;
    }

    if (fine?.hrApprovedBy && identitiesMatch(req.user, fine.hrApprovedBy)) {
        return true;
    }

    return false;
}

export function restrictApprovedFineUpdates(updates = {}, fine) {
    const allowed = {};

    if (updates.monthStart !== undefined) {
        allowed.monthStart = updates.monthStart;
    }

    if (updates.payableDuration !== undefined) {
        const duration = parseInt(updates.payableDuration, 10);
        allowed.payableDuration = Number.isFinite(duration) && duration >= 1
            ? duration
            : (fine?.payableDuration || 1);
    }

    if (Object.keys(allowed).length === 0) {
        return {
            error: 'Approved fines can only be updated for Payable From and duration.',
            allowed: {},
        };
    }

    return { allowed };
}
