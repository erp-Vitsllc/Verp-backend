import { getDepartmentHOD } from './getDepartmentHOD.js';
import { resolveEmployeeEmail } from './resolveEmployeeEmail.js';

/** Flowchart Admin — recipient for company-share fine notifications. */
export async function resolveCompanyFineAdminRecipient() {
    const admin = await getDepartmentHOD('admincontroller');
    if (!admin) return null;

    const { email, employeeName } = resolveEmployeeEmail(admin);
    const name =
        employeeName ||
        `${admin.firstName || ''} ${admin.lastName || ''}`.trim() ||
        'Administrator';

    if (!email) return null;
    return { email, name, employee: admin };
}
