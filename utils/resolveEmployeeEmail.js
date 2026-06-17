import { isEmployeeActiveForNotifications } from "./applyEmployeeLeftUserStatus.js";

/**
 * Business email only: assignee companyEmail, then assignee workEmail, else primary reportee company/work.
 * Never uses personalEmail or generic personal email fields.
 */

function reporteeBusinessEmail(reportee) {
    if (!reportee || typeof reportee !== 'object') return null;
    const company = String(reportee.companyEmail || '').trim();
    if (company) return company;
    const work = String(reportee.workEmail || '').trim();
    if (work) return work;
    return null;
}

/**
 * @param {Object} emp - Employee object (primaryReportee populated when using fallback)
 * @returns {{ email: string|null, isFallbackToReportee: boolean }}
 */
export const resolveEmployeeEmail = (emp) => {
    if (!emp) return { email: null, isFallbackToReportee: false };

    if (!isEmployeeActiveForNotifications(emp)) {
        return { email: null, isFallbackToReportee: false };
    }

    const company = String(emp.companyEmail || '').trim();
    if (company) {
        return { email: company, isFallbackToReportee: false };
    }

    const workSelf = String(emp.workEmail || '').trim();
    if (workSelf) {
        return { email: workSelf, isFallbackToReportee: false };
    }

    const reporteeEmail = reporteeBusinessEmail(emp.primaryReportee);
    if (reporteeEmail) {
        return { email: reporteeEmail, isFallbackToReportee: true };
    }

    return { email: null, isFallbackToReportee: false };
};

/** @returns {string|null} */
export const pickEffectiveEmail = (emp) => resolveEmployeeEmail(emp).email;

/** Company / reportee business email only (no personal CC). */
export const resolveEmployeeEmailTargets = (emp) => {
    const { email: primary } = resolveEmployeeEmail(emp);
    if (!primary) return { to: null, cc: [] };
    return { to: primary, cc: [] };
};

/** Add business email for emp (and reportee fallback) into a Set — never personal. */
export function addEmployeeEmailToSet(emailSet, emp) {
    if (!emailSet || !emp) return;
    const { email } = resolveEmployeeEmail(emp);
    if (email) emailSet.add(email);
}

/**
 * Load primaryReportee when needed, then resolve business email.
 */
export async function resolveEmployeeEmailWithReporteeLoaded(emp) {
    if (!emp) {
        return { email: null, isFallbackToReportee: false, employee: null };
    }

    if (!isEmployeeActiveForNotifications(emp)) {
        return { email: null, isFallbackToReportee: false, employee: emp };
    }

    let full = emp;
    const initial = resolveEmployeeEmail(emp);

    const reporteeIsIdOnly =
        emp.primaryReportee &&
        (typeof emp.primaryReportee === 'string' ||
            (typeof emp.primaryReportee === 'object' && emp.primaryReportee._id && !emp.primaryReportee.companyEmail));

    const needsDbLoad =
        !initial.email &&
        (emp._id || emp.employeeId) &&
        (!emp.primaryReportee || reporteeIsIdOnly);

    if (needsDbLoad) {
        const EmployeeBasic = (await import('../models/EmployeeBasic.js')).default;
        const query = emp._id
            ? EmployeeBasic.findById(emp._id)
            : EmployeeBasic.findOne({ employeeId: emp.employeeId });
        full = await query
            .select('firstName lastName employeeId companyEmail workEmail primaryReportee status profileStatus')
            .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail status profileStatus')
            .lean();
    }

    if (!full) {
        return { email: null, isFallbackToReportee: false, employee: emp };
    }

    if (!isEmployeeActiveForNotifications(full)) {
        return { email: null, isFallbackToReportee: false, employee: full };
    }

    const resolved = resolveEmployeeEmail(full);
    return { ...resolved, employee: full };
}

export function employeeDisplayName(emp) {
    if (!emp) return 'Employee';
    return `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || emp.employeeId || 'Employee';
}

/**
 * HTML note when the mail went to primary reportee instead of the employee.
 */
export const getFallbackEmailNote = (employeeName, reporteeName) => `
    <div style="background-color: #fff3cd; border: 1px solid #ffc107; padding: 12px; border-radius: 6px; margin-bottom: 20px; font-size: 13px;">
        <strong>Note:</strong> This notification was sent to you (${reporteeName}) because <strong>${employeeName}</strong> does not have a company email on file. Please ensure they are informed.
    </div>`;
