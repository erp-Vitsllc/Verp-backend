import mongoose from 'mongoose';
import User from '../models/User.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { getDepartmentHOD, isUserActiveInFlowchart } from './getDepartmentHOD.js';

/** Mongo id string. ObjectId.id is a 12-byte buffer and must not be sent to findById. */
export function storedUserId(value) {
    if (value == null || value === '') return null;
    if (value instanceof mongoose.Types.ObjectId) return value.toString();
    if (typeof value === 'string') {
        const text = value.trim();
        if (mongoose.Types.ObjectId.isValid(text) && text.length === 24) return text;
        return null;
    }
    if (typeof value === 'object') {
        if (value._id != null && value._id !== value) return storedUserId(value._id);
        if (typeof value.id === 'string') return storedUserId(value.id);
    }
    return null;
}

const FLOWCHART_ROLES = ['hr', 'accounts', 'admincontroller'];

async function resolveCreatorUser(userLike) {
    if (!userLike) return null;
    if (
        typeof userLike === 'object'
        && !(userLike instanceof mongoose.Types.ObjectId)
        && (userLike.employeeId || userLike.employeeObjectId)
    ) {
        return {
            _id: storedUserId(userLike._id) || storedUserId(userLike.id),
            employeeId: userLike.employeeId || '',
            employeeObjectId: userLike.employeeObjectId || null,
        };
    }
    const id = storedUserId(userLike);
    if (!id) return null;
    const doc = await User.findById(id).select('_id employeeId').lean();
    if (!doc) return null;
    let employeeObjectId = null;
    if (doc.employeeId) {
        const employee = await EmployeeBasic.findOne({ employeeId: doc.employeeId }).select('_id').lean();
        employeeObjectId = employee?._id || null;
    }
    return {
        _id: doc._id,
        employeeId: doc.employeeId || '',
        employeeObjectId,
    };
}

/** Creator is the flowchart HR, Accounts, or Admin Officer. */
export async function loanCreatorSkipsAccountsApproval(userLike) {
    const user = await resolveCreatorUser(userLike);
    if (!user?.employeeId && !user?.employeeObjectId) return false;
    for (const role of FLOWCHART_ROLES) {
        if (await isUserActiveInFlowchart(user, role)) return true;
    }
    return false;
}

/** Next stage after HR approves. Existing loans keep Accounts in the middle. */
export function stageAfterHrApproval(loan) {
    const accountsDone = (loan?.workflow || []).some(
        (step) => step.role === 'Accounts' && step.status === 'Approved',
    );
    if (loan?.skipAccountsApproval === true || loan?.accountsApprovedBy || accountsDone) {
        return 'Pending Authorization';
    }
    return 'Pending Accounts';
}

async function assignmentUserId(hod) {
    if (!hod) return null;
    if (hod.employeeId) {
        const user = await User.findOne({ employeeId: hod.employeeId }).select('_id').lean();
        if (user?._id) return user._id;
    }
    return hod._id || null;
}

/**
 * Opening approval for a new submit.
 * HR, Accounts, or Admin Officer: HR first, no Accounts approval.
 * Anyone else: Accounts first, then the existing HR and Management steps.
 */
export async function assignLoanOpeningApproval(loanLike, creatorUser, comment = '') {
    const skip = await loanCreatorSkipsAccountsApproval(creatorUser);
    const hod = await getDepartmentHOD(skip ? 'hr' : 'accounts');
    const assignedTo = await assignmentUserId(hod);
    const stage = skip ? 'Pending HR' : 'Pending Accounts';
    loanLike.skipAccountsApproval = skip;
    loanLike.accountsFirst = !skip;
    loanLike.status = stage;
    loanLike.approvalStatus = stage;
    if (assignedTo) loanLike.submittedTo = assignedTo;
    loanLike.workflow = assignedTo
        ? [{
            role: skip ? 'HR Admin' : 'Accounts',
            assignedTo,
            status: 'Pending',
            assignedAt: new Date(),
            comment: comment || '',
        }]
        : [];
    return { skip, hod, stage };
}

/** Next stage after Accounts approves. Accounts-first still continues to HR. */
export function stageAfterAccountsApproval(loan) {
    const hrDone = (loan?.workflow || []).some(
        (step) => (step.role === 'HR' || step.role === 'HR Admin') && step.status === 'Approved',
    );
    if (loan?.accountsFirst === true && !loan?.hrApprovedBy && !hrDone) return 'Pending HR';
    return 'Pending Authorization';
}
