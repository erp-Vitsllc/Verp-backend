import { generatePdfFromHtml, pdfOutputToBuffer } from './generatePdf.js';
import {
    buildSalarySlipPdfHtml,
    SALARY_SLIP_PDF_SELECTOR,
} from './buildSalarySlipPdfHtml.js';
import { buildSalarySlipPayload } from './buildSalarySlipPayload.js';

export async function generateSalarySlipPdfBuffer(options = {}) {
    const slip = await buildSalarySlipPayload(options);
    const html = buildSalarySlipPdfHtml(slip);
    const raw = await generatePdfFromHtml(html, SALARY_SLIP_PDF_SELECTOR);
    const buf = pdfOutputToBuffer(raw);
    if (!buf || buf.length <= 500) {
        throw new Error('Failed to generate salary slip PDF.');
    }
    return { buffer: buf, slip };
}
