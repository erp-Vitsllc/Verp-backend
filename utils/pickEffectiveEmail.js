/**
 * Utility to pick the best available email for an employee.
 * Logic:
 * 1. Primary choice: companyEmail
 * 2. Fallback 1: workEmail (if exists)
 * 3. Fallback 2: personal email (email or personalEmail)
 * 4. Fallback 3: Primary Reportee's company email (as per user request)
 *
 * @param {object} employee - The employee object (can be lean or populated)
 * @returns {string|null} - The best email address found
 */
export const pickEffectiveEmail = (employee) => {
    if (!employee) return null;

    // 1. Direct company email
    const companyEmail = String(employee.companyEmail || '').trim();
    if (companyEmail) return companyEmail;

    // 2. Work email (some models might have it)
    const workEmail = String(employee.workEmail || '').trim();
    if (workEmail) return workEmail;

    // 3. Personal email
    const personalEmail = String(employee.email || employee.personalEmail || '').trim();
    if (personalEmail) return personalEmail;

    // 4. Primary Reportee's company email (Fallback for employees without their own)
    // Note: primaryReportee must be populated by the caller for this to work.
    if (employee.primaryReportee && typeof employee.primaryReportee === 'object') {
        const reporteeEmail = String(employee.primaryReportee.companyEmail || employee.primaryReportee.workEmail || '').trim();
        if (reporteeEmail) return reporteeEmail;
    }

    return null;
};
