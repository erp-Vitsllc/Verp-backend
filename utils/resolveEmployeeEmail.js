/**
 * Resolves the recipient email for an employee notification.
 * If employee has no companyEmail/email, falls back to primaryReportee's companyEmail.
 * Ensures only responsible persons receive emails (employee or their manager).
 *
 * @param {Object} emp - Employee object
 * @param {Object} [emp.primaryReportee] - Optional populated primaryReportee
 * @returns {{ email: string|null, isFallbackToReportee: boolean, employeeName?: string, reporteeName?: string }}
 */
export const resolveEmployeeEmail = (emp) => {
    if (!emp) return { email: null, isFallbackToReportee: false };

    // Business rule: if employee has NO `companyEmail`, notify their primaryReportee instead.
    // (Even if they have `email`/workEmail/personalEmail, we still route based on companyEmail.)
    const empCompanyEmail = (emp.companyEmail || '').trim();
    if (empCompanyEmail) {
        return { email: empCompanyEmail, isFallbackToReportee: false };
    }

    const reportee = emp.primaryReportee;
    const reporteeEmail = (reportee?.companyEmail || reportee?.workEmail || reportee?.personalEmail || reportee?.email || '').trim();
    if (reporteeEmail) {
        const employeeName = `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || emp.employeeId || 'Employee';
        const reporteeName = `${reportee.firstName || ''} ${reportee.lastName || ''}`.trim() || 'Manager';
        return {
            email: reporteeEmail,
            isFallbackToReportee: true,
            employeeName,
            reporteeName
        };
    }

    // Last resort: if reportee has no email either, fall back to any available employee email.
    const fallbackEmpEmail = (emp.workEmail || emp.personalEmail || emp.email || '').trim();
    if (fallbackEmpEmail) {
        return { email: fallbackEmpEmail, isFallbackToReportee: false };
    }

    return { email: null, isFallbackToReportee: false };
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
