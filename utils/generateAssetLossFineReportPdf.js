import { fillAssetLossFineReportPdfTemplate } from './fillAssetLossFineReportPdfTemplate.js';
import { resolveAssetLossFineReportSignatures } from './resolveAssetLossFineReportSignatures.js';
import { loadFineRecordForAssetLossPdf } from './loadFineRecordForAssetLossPdf.js';

/**
 * Generates Asset Loss Fine Report PDF by filling the official template PDF (not HTML).
 */
export async function generateAssetLossFineReportPdf({
    fine,
    assigned,
    formSummary,
    employeeName,
    hodName,
    hrEmployee = null,
    accountsEmployee = null,
}) {
    try {
        const fineDoc = await loadFineRecordForAssetLossPdf(fine, assigned?.employeeId);

        const signatureUrls = await resolveAssetLossFineReportSignatures({
            assignedEmployeeId: assigned?.employeeId,
            hodEmployee: null,
            hrEmployee,
            accountsEmployee,
            fine: fineDoc,
        });

        const buf = await fillAssetLossFineReportPdfTemplate({
            fine: fineDoc,
            assigned,
            formSummary,
            employeeName,
            hodName,
            signatureUrls,
        });

        return buf && buf.length > 500 ? buf : null;
    } catch (err) {
        console.error('[generateAssetLossFineReportPdf]', err?.message || err);
        return null;
    }
}
