import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import { resolveFlowchartHrEmployee } from './resolveFlowchartHrEmployee.js';
import { isUsernameSystemSuperUser } from './systemSuperUser.js';

function employeeIdExactRegex(value) {
    const parts = String(value || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    if (!parts.length) return null;
    const pattern = parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
    return new RegExp(`^${pattern}$`, 'i');
}

function passwordError(message, statusCode = 400) {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
}

/**
 * Confirm the signed-in user's login password.
 * Wrong passwords must be 400 — never 401, or the client interceptor logs the session out.
 */
export async function verifyLoggedInUserPassword(req, password) {
    const raw = String(password ?? '');
    if (!raw) {
        throw passwordError('Password is required.');
    }

    const userId = req.user?.id || req.user?._id;
    if (!userId) {
        throw passwordError('You must be signed in to confirm this action.', 403);
    }

    const user = await User.findById(userId).select('password username');
    if (!user) {
        throw passwordError('User account was not found.', 403);
    }

    if (isUsernameSystemSuperUser(user.username) || req.user?.isSystemSuperUser) {
        const adminPassword = process.env.ADMIN_PASSWORD;
        if (!adminPassword) {
            throw passwordError('System admin password is not configured.', 403);
        }
        if (raw !== adminPassword) {
            throw passwordError('Incorrect password.');
        }
        return true;
    }

    if (!user.password) {
        throw passwordError('Login password is not set for this user.', 403);
    }

    const ok = await bcrypt.compare(raw, user.password);
    if (!ok) {
        throw passwordError('Incorrect password.');
    }
    return true;
}

/**
 * Confirm against the Flowchart HR user's login password stored in the User collection.
 */
export async function verifyFlowchartHrUserPassword(password) {
    const raw = String(password ?? '');
    if (!raw) {
        throw passwordError('Password is required.');
    }

    const hrResolved = await resolveFlowchartHrEmployee();
    if (hrResolved?.error || !hrResolved?.employee) {
        throw passwordError(hrResolved?.message || 'Flowchart HR is not configured.', 403);
    }

    const hrEmployeeId = String(hrResolved.employee.employeeId || '').trim();
    const re = employeeIdExactRegex(hrEmployeeId);
    if (!re) {
        throw passwordError('Flowchart HR is not linked to a login user.', 403);
    }

    const hrEmail = String(
        hrResolved.email || hrResolved.employee?.companyEmail || hrResolved.employee?.email || '',
    )
        .trim()
        .toLowerCase();
    const userQuery = [{ employeeId: { $regex: re } }];
    if (hrEmail) {
        userQuery.push({ email: hrEmail }, { companyEmail: hrEmail });
    }

    const hrUser = await User.findOne({ $or: userQuery }).select('password employeeId');
    if (!hrUser?.password) {
        throw passwordError('Flowchart HR login password is not set.', 403);
    }

    const ok = await bcrypt.compare(raw, hrUser.password);
    if (!ok) {
        throw passwordError('Incorrect password.');
    }
    return true;
}
