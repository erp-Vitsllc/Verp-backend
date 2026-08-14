/**
 * Company payment / portal shells are stored as EmployeeBasic with lastName "(Company)".
 * They must never receive attendance marks or appear in attendance inboxes.
 */
export function isCompanyShellEmployee(empOrName) {
    if (!empOrName) return false;
    if (typeof empOrName === 'string') {
        return /\(company\)\s*$/i.test(empOrName.trim());
    }
    const last = String(empOrName.lastName || '').trim();
    if (/^\(company\)$/i.test(last)) return true;
    const full = `${empOrName.firstName || ''} ${empOrName.lastName || ''} ${empOrName.employeeName || ''}`.trim();
    return /\(company\)\s*$/i.test(full);
}

/** Mongo filter fragment: real people only (exclude company shells). */
export const REAL_EMPLOYEE_MONGO_FILTER = {
    lastName: { $not: /^\(company\)$/i },
};
