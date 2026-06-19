import { generatePdfFromHtml, pdfOutputToBuffer } from './generatePdf.js';
import {
    buildEmployeeAssetListPdfHtml,
    buildEmployeeAssetListRows,
    EMPLOYEE_ASSET_LIST_PDF_SELECTOR,
    formatAssetListDate,
} from './buildEmployeeAssetListPdfHtml.js';

function employeeDisplayName(employee) {
    if (!employee) return '—';
    const name = `${employee.firstName || ''} ${employee.lastName || ''}`.trim();
    return name || employee.employeeId || '—';
}

function resolveHodName(employee) {
    const hod = employee?.primaryReportee || employee?.reportingAuthority;
    if (!hod) return '—';
    if (typeof hod === 'object') {
        const name = `${hod.firstName || ''} ${hod.lastName || ''}`.trim();
        return name || hod.employeeId || '—';
    }
    return String(hod);
}

/**
 * Server-generated employee asset list PDF for Salary → Assets tab download.
 */
export async function generateEmployeeAssetListPdf({ employee, assets }) {
    try {
        const listRows = buildEmployeeAssetListRows(assets);
        const html = buildEmployeeAssetListPdfHtml({
            employeeName: employeeDisplayName(employee),
            employeeCode: employee?.employeeId || '—',
            hodName: resolveHodName(employee),
            reportDate: formatAssetListDate(new Date()),
            listRows,
        });

        const raw = await generatePdfFromHtml(html, EMPLOYEE_ASSET_LIST_PDF_SELECTOR);
        const buf = pdfOutputToBuffer(raw);
        return buf && buf.length > 500 ? buf : null;
    } catch (err) {
        console.error('[generateEmployeeAssetListPdf]', err?.message || err);
        return null;
    }
}
