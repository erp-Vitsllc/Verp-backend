import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import { resolveFlowchartHrEmployee } from './resolveFlowchartHrEmployee.js';

function employeeIdExactRegex(value) {
    const parts = String(value || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    if (!parts.length) return null;
    const pattern = parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
    return new RegExp(`^${pattern}$`, 'i');
}

/**
 * Confirm against the Flowchart HR user's login password stored in the User collection.
 */
export async function verifyFlowchartHrUserPassword(password) {
    const raw = String(password ?? '');
    if (!raw) {
        const err = new Error('Password is required.');
        err.statusCode = 400;
        throw err;
    }

    const hrResolved = await resolveFlowchartHrEmployee();
    if (hrResolved?.error || !hrResolved?.employee) {
        const err = new Error(hrResolved?.message || 'Flowchart HR is not configured.');
        err.statusCode = 403;
        throw err;
    }

    const hrEmployeeId = String(hrResolved.employee.employeeId || '').trim();
    const re = employeeIdExactRegex(hrEmployeeId);
    if (!re) {
        const err = new Error('Flowchart HR is not linked to a login user.');
        err.statusCode = 403;
        throw err;
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
        const err = new Error('Flowchart HR login password is not set.');
        err.statusCode = 401;
        throw err;
    }

    const ok = await bcrypt.compare(raw, hrUser.password);
    if (!ok) {
        const err = new Error('Incorrect password.');
        err.statusCode = 401;
        throw err;
    }
    return true;
}
