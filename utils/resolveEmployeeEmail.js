/**
 * Resolves recipient email for notifications using companyEmail ONLY.
 * No fallback to personal/work/secondary addresses.
 *
 * @param {Object} emp - Employee object
 * @returns {{ email: string|null, isFallbackToReportee: boolean }}
 */
export const resolveEmployeeEmail = (emp) => {
    if (!emp) return { email: null, isFallbackToReportee: false };
    const empCompanyEmail = (emp.companyEmail || '').trim();
    if (empCompanyEmail) {
        return { email: empCompanyEmail, isFallbackToReportee: false };
    }

    return { email: null, isFallbackToReportee: false };
};

/** Company-email-only target resolution (no personal/work CC). */
export const resolveEmployeeEmailTargets = (emp) => {
    const { email: primary } = resolveEmployeeEmail(emp);
    if (!primary) return { to: null, cc: [] };
    return { to: primary, cc: [] };
};

/**
 * Returns HTML snippet to add to email body when email was sent to reportee (manager) instead of employee.
 * @param {string} employeeName - Name of the employee who is the subject
 * @param {string} reporteeName - Name of the reportee receiving the email
 */
export const getFallbackEmailNote = (employeeName, reporteeName) => `
    <div style="background-color: #fff3cd; border: 1px solid #ffc107; padding: 12px; border-radius: 6px; margin-bottom: 20px; font-size: 13px;">
        <strong>Note:</strong> This notification is being sent to you (${reporteeName}) because your reportee <strong>${employeeName}</strong> does not have a company email on file. Please ensure they are informed.
    </div>
`;
