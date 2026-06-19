import EmployeeBasic from '../models/EmployeeBasic.js';
import User from '../models/User.js';
import { getSignedFileUrl } from './s3Upload.js';
import { resolveSignatureUrlForPdf } from './generateBulkAssetInventoryPdf.js';
import { emailFrontendUrl } from './resolveFrontendBaseUrl.js';

function displayName(emp) {
    if (!emp) return '';
    return `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || emp.employeeName || '';
}

function hasSignature(emp) {
    return !!(emp?.signature?.url || emp?.signature?.publicId);
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

async function resolveSigUrl(emp) {
    if (!emp?.signature) return undefined;

    const sig = emp.signature;
    if (sig.url?.startsWith('data:')) return sig.url;

    for (const key of [sig.publicId, sig.url].filter(Boolean)) {
        if (String(key).startsWith('data:')) return key;
        try {
            const signed = await getSignedFileUrl(key);
            if (signed) return signed;
        } catch {
            /* try next key */
        }
    }

    const viaApi = resolveSignatureUrlForPdf(sig, emailFrontendUrl());
    if (viaApi && !/localhost|127\.0\.0\.1/i.test(viaApi)) return viaApi;
    return undefined;
}

/**
 * Digital signatures from employee profiles — HR/Accounts use the actual fine approvers.
 */
export async function resolveAssetLossFineReportSignatures({
    assignedEmployeeId,
    hodEmployee = null,
    hrEmployee = null,
    accountsEmployee = null,
    fine = null,
}) {
    const employee = assignedEmployeeId
        ? await EmployeeBasic.findOne({ employeeId: assignedEmployeeId })
            .select('firstName lastName employeeId signature primaryReportee')
            .populate('primaryReportee', 'firstName lastName employeeId signature')
            .lean()
        : null;

    let hod = hodEmployee;
    if (!hod && employee?.primaryReportee && typeof employee.primaryReportee === 'object') {
        hod = employee.primaryReportee;
    } else if (!hod && employee?.primaryReportee) {
        hod = await EmployeeBasic.findById(employee.primaryReportee)
            .select('firstName lastName employeeId signature')
            .lean();
    }

    // Use the HR / Accounts staff who actually approved this fine (signatures on file).
    let hr = null;
    if (fine?.hrApprovedBy) {
        hr = await employeeFromUserId(fine.hrApprovedBy);
    }
    if (!hasSignature(hr) && hrEmployee) {
        hr = hrEmployee;
    }

    let accounts = null;
    if (fine?.accountsApprovedBy) {
        accounts = await employeeFromUserId(fine.accountsApprovedBy);
    }
    if (!hasSignature(accounts) && accountsEmployee) {
        accounts = accountsEmployee;
    }

    const [employeeUrl, hodUrl, hrUrl, accountsUrl] = await Promise.all([
        resolveSigUrl(employee),
        resolveSigUrl(hod),
        resolveSigUrl(hr),
        resolveSigUrl(accounts),
    ]);

    return {
        employee: {
            name: displayName(employee),
            url: employeeUrl,
            signature: employee?.signature,
            employeeId: employee?.employeeId,
        },
        hod: { name: displayName(hod), url: hodUrl, signature: hod?.signature, employeeId: hod?.employeeId },
        hr: { name: displayName(hr), url: hrUrl, signature: hr?.signature, employeeId: hr?.employeeId },
        accounts: {
            name: displayName(accounts),
            url: accountsUrl,
            signature: accounts?.signature,
            employeeId: accounts?.employeeId,
        },
    };
}
