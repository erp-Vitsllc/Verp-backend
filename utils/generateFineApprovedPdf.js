import { generatePdfFromHtml, pdfOutputToBuffer } from './generatePdf.js';
import { buildFineApprovedPdfHtml, FINE_APPROVED_PDF_SELECTOR } from './buildFineApprovedPdfHtml.js';
import { resolveFineFormSignatureUrls } from './resolveFineFormSignatureUrls.js';

/**
 * Server-generated Asset Loss Fine Report PDF (letterhead + transparent form + digital signatures).
 */
export async function generateFineApprovedPdf({
    fine,
    assigned,
    formSummary,
    employeeName,
    hodName,
    hrEmployee = null,
    accountsEmployee = null,
}) {
    try {
        const signatureUrls = await resolveFineFormSignatureUrls({
            assignedEmployeeId: assigned.employeeId,
            hodEmployee: null,
            hrEmployee,
            accountsEmployee,
            fine,
        });

        const html = buildFineApprovedPdfHtml({
            fine,
            assigned,
            formSummary,
            employeeName,
            hodName,
            signatureUrls,
        });

        const raw = await generatePdfFromHtml(html, FINE_APPROVED_PDF_SELECTOR);
        const buf = pdfOutputToBuffer(raw);
        return buf && buf.length > 500 ? buf : null;
    } catch (err) {
        console.error('[generateFineApprovedPdf]', err?.message || err);
        return null;
    }
}
