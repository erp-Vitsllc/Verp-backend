import { generatePdfFromHtml, pdfOutputToBuffer } from './generatePdf.js';
import {
    buildLoanAcknowledgmentPdfHtml,
    LOAN_ACKNOWLEDGMENT_PDF_SELECTOR,
    formatDisplayDate,
} from './buildLoanAcknowledgmentPdfHtml.js';
import { resolveLoanFormSignatureUrls } from './resolveLoanFormSignatureUrls.js';
import { getCompleteEmployee } from '../services/employeeService.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import Company from '../models/Company.js';

function formatLetterDate(value) {
    if (!value) return formatDisplayDate(new Date());
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return formatDisplayDate(new Date());
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
}

async function resolveCompanyName(employee) {
    if (employee?.company?.name) return employee.company.name;
    if (!employee?.company) return 'VEGA DIGITAL IT SOLUTIONS LLC';
    try {
        const companyId = employee.company._id || employee.company;
        const company = await Company.findById(companyId).select('name').lean();
        return company?.name || 'VEGA DIGITAL IT SOLUTIONS LLC';
    } catch {
        return 'VEGA DIGITAL IT SOLUTIONS LLC';
    }
}

/**
 * Server-generated Loan / Advance Acknowledgment PDF (management approval email + Attachment tab).
 */
export async function generateLoanAcknowledgmentPdf(loanDoc) {
    if (!loanDoc?.employeeId) return null;

    try {
        const employee = await getCompleteEmployee(loanDoc.employeeId);
        if (!employee) return null;

        const hrHOD = await getDepartmentHOD('hr', employee._id);
        const accountsHOD = await getDepartmentHOD('finance', employee._id);

        const signatureUrls = await resolveLoanFormSignatureUrls({
            employee,
            hrEmployee: hrHOD,
            accountsEmployee: accountsHOD,
            loan: loanDoc,
        });

        const companyName = await resolveCompanyName(employee);
        const employeeName = `${employee.firstName || ''} ${employee.lastName || ''}`.trim() || loanDoc.applicantName || 'Employee';
        const emiratesId = employee.emiratesIdDetails?.number || employee.emiratesId || '—';
        const letterDate = formatLetterDate(loanDoc.approvedDate || new Date());
        const receivedDate = formatDisplayDate(loanDoc.approvedDate || loanDoc.appliedDate || new Date());

        const html = buildLoanAcknowledgmentPdfHtml({
            loan: loanDoc,
            employeeName,
            department: employee.department || loanDoc.department,
            emiratesId,
            companyName,
            signatureUrls,
            letterDate,
            receivedDate,
        });

        const raw = await generatePdfFromHtml(html, LOAN_ACKNOWLEDGMENT_PDF_SELECTOR);
        const buf = pdfOutputToBuffer(raw);
        return buf && buf.length > 500 ? buf : null;
    } catch (err) {
        console.error('[generateLoanAcknowledgmentPdf]', err?.message || err);
        return null;
    }
}

export async function generateLoanAcknowledgmentPdfBuffer(loanDoc) {
    return generateLoanAcknowledgmentPdf(loanDoc);
}
