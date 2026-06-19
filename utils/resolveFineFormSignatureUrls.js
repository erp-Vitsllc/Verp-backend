import EmployeeBasic from '../models/EmployeeBasic.js';
import User from '../models/User.js';
import { resolveHandoverSignatureUrl } from './buildAssignmentHandoverEmailAttachments.js';
import { emailFrontendUrl } from './resolveFrontendBaseUrl.js';

function displayName(emp) {
    if (!emp) return '';
    return `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || emp.employeeName || '';
}

async function employeeFromUserId(userId) {
    if (!userId) return null;
    const user = await User.findById(userId).select('employeeId firstName lastName').lean();
    if (!user?.employeeId) return user;
    const emp = await EmployeeBasic.findOne({ employeeId: user.employeeId })
        .select('firstName lastName employeeId signature')
        .lean();
    return emp || user;
}

async function resolveSig(emp) {
    if (!emp?.signature) return undefined;
    const fe = emailFrontendUrl();
    return resolveHandoverSignatureUrl(emp.signature, fe);
}

/**
 * Resolve digital signature image URLs for fine form PDF (employee, HOD, HR, accounts).
 */
export async function resolveFineFormSignatureUrls({
    assignedEmployeeId,
    hodEmployee = null,
    hrEmployee = null,
    accountsEmployee = null,
    fine = null,
}) {
    const employee = assignedEmployeeId
        ? await EmployeeBasic.findOne({ employeeId: assignedEmployeeId })
            .select('firstName lastName employeeId signature primaryReportee')
            .lean()
        : null;

    let hod = hodEmployee;
    if (!hod && employee?.primaryReportee) {
        hod = await EmployeeBasic.findById(employee.primaryReportee)
            .select('firstName lastName employeeId signature')
            .lean();
    }

    let hr = hrEmployee;
    if (!hr && fine?.hrApprovedBy) {
        hr = await employeeFromUserId(fine.hrApprovedBy);
    }

    let accounts = accountsEmployee;
    if (!accounts && fine?.accountsApprovedBy) {
        accounts = await employeeFromUserId(fine.accountsApprovedBy);
    }

    const [employeeUrl, hodUrl, hrUrl, accountsUrl] = await Promise.all([
        resolveSig(employee),
        resolveSig(hod),
        resolveSig(hr),
        resolveSig(accounts),
    ]);

    return {
        employee: { name: displayName(employee), url: employeeUrl },
        hod: { name: displayName(hod), url: hodUrl },
        hr: { name: displayName(hr), url: hrUrl },
        accounts: { name: displayName(accounts), url: accountsUrl },
    };
}
