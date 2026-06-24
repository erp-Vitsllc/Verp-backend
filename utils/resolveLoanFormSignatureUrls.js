import EmployeeBasic from '../models/EmployeeBasic.js';
import { resolveHandoverSignatureUrl } from './buildAssignmentHandoverEmailAttachments.js';
import { emailFrontendUrl } from './resolveFrontendBaseUrl.js';
import { downloadS3ObjectBytes } from './s3Upload.js';

function displayName(emp) {
    if (!emp) return '';
    return `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || emp.employeeName || '';
}

async function employeeFromObjectId(objectId) {
    if (!objectId) return null;
    return EmployeeBasic.findById(objectId).select('firstName lastName employeeId signature').lean();
}

async function employeeByEmployeeId(employeeId) {
    if (!employeeId) return null;
    return EmployeeBasic.findOne({ employeeId })
        .select('firstName lastName employeeId signature primaryReportee department')
        .lean();
}

async function employeeByLoan(loan, employee) {
    if (loan?.employeeObjectId) {
        const byId = await EmployeeBasic.findById(loan.employeeObjectId)
            .select('firstName lastName employeeId signature primaryReportee department')
            .lean();
        if (byId) return byId;
    }
    if (loan?.employeeId) {
        const byEmpId = await employeeByEmployeeId(loan.employeeId);
        if (byEmpId) return byEmpId;
    }
    if (employee?.employeeId && !employee?.signature) {
        const byEmpId = await employeeByEmployeeId(employee.employeeId);
        if (byEmpId) return byEmpId;
    }
    return employee;
}

function hasSignatureData(sig) {
    if (!sig) return false;
    if (typeof sig === 'string') return sig.trim().length > 0;
    return !!(sig.url || sig.publicId || sig.data || sig.path);
}

async function embedSignatureForPdf(emp) {
    if (!hasSignatureData(emp?.signature)) {
        return { name: displayName(emp), url: undefined };
    }

    const sig = emp.signature;
    const fe = emailFrontendUrl();

    if (typeof sig === 'string' && sig.startsWith('data:')) {
        return { name: displayName(emp), url: sig };
    }

    const keyOrUrl = sig.publicId || sig.url || sig.data || sig.path;
    if (keyOrUrl) {
        try {
            const bytes = await downloadS3ObjectBytes(keyOrUrl);
            if (bytes?.length) {
                const mime = sig.mimeType || 'image/png';
                return {
                    name: displayName(emp),
                    url: `data:${mime};base64,${bytes.toString('base64')}`,
                };
            }
        } catch {
            /* fall through to signed URL */
        }
    }

    const signedUrl = await resolveHandoverSignatureUrl(sig, fe);
    return { name: displayName(emp), url: signedUrl || undefined };
}

/**
 * Digital signatures for loan acknowledgment PDF (employee, HOD, HR, accounts).
 * Embeds S3 signatures as data URLs so Puppeteer always renders them in PDFs.
 */
export async function resolveLoanFormSignatureUrls({
    employee = null,
    hodEmployee = null,
    hrEmployee = null,
    accountsEmployee = null,
    loan = null,
}) {
    let employeeRecord = await employeeByLoan(loan, employee);

    let hod = null;
    const reporteeId =
        employeeRecord?.primaryReportee?._id
        || employeeRecord?.primaryReportee
        || hodEmployee?._id
        || hodEmployee;
    if (reporteeId) {
        hod = await employeeFromObjectId(reporteeId);
    }

    let hr = null;
    if (loan?.hrApprovedBy) {
        hr = await employeeFromObjectId(loan.hrApprovedBy);
    } else if (hrEmployee) {
        hr = hrEmployee;
    }

    let accounts = null;
    if (loan?.accountsApprovedBy) {
        accounts = await employeeFromObjectId(loan.accountsApprovedBy);
    } else if (accountsEmployee) {
        accounts = accountsEmployee;
    }

    const [employeeSig, hodSig, hrSig, accountsSig] = await Promise.all([
        embedSignatureForPdf(employeeRecord),
        embedSignatureForPdf(hod),
        embedSignatureForPdf(hr),
        embedSignatureForPdf(accounts),
    ]);

    return {
        employee: employeeSig,
        hod: hodSig,
        hr: hrSig,
        accounts: accountsSig,
    };
}
