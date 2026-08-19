import { generateFineApprovedPdf } from './generateFineApprovedPdf.js';
import { loadFineRecordForAssetLossPdf } from './loadFineRecordForAssetLossPdf.js';

/**
 * Generates the approved fine report PDF (redesigned layout on VITS letterhead).
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
        return generateFineApprovedPdf({
            fine: fineDoc,
            assigned,
            formSummary,
            employeeName,
            hodName,
            hrEmployee,
            accountsEmployee,
        });
    } catch (err) {
        console.error('[generateAssetLossFineReportPdf]', err?.message || err);
        return null;
    }
}
