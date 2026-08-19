import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildAssetLossFineEmailFields } from './buildAssetLossFineEmailFields.js';
import { buildApprovedFineReportInnerHtml } from './buildApprovedFineReportInnerHtml.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Official VITS Abudhabi letterhead (rasterized from VITS-Letter-Head-Abudhabi.pdf). */
const LETTERHEAD_PNG_PATH = path.join(
    __dirname,
    '../assets/letterhead/vits_letterhead_abudhabi.png',
);
/** Legacy fallback if the Abudhabi asset is missing. */
const LEGACY_LETTERHEAD_PATH = path.join(__dirname, '../assets/email/fine-form-letterhead.png');

/**
 * Safe content insets — keep form clear of letterhead header/footer artwork.
 * Matches frontend `src/pdf/vitsLetterhead/constants.js`.
 */
const SAFE_TOP = '36mm';
const SAFE_BOTTOM = '52mm';
const SAFE_X = '18mm';

export const FINE_APPROVED_PDF_SELECTOR = '#fine-approved-pdf[data-fine-approved-ready="true"]';

function esc(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function getLetterheadDataUrl() {
    const filePath = fs.existsSync(LETTERHEAD_PNG_PATH)
        ? LETTERHEAD_PNG_PATH
        : LEGACY_LETTERHEAD_PATH;
    if (!fs.existsSync(filePath)) return '';
    const b64 = fs.readFileSync(filePath).toString('base64');
    const mime = filePath.toLowerCase().endsWith('.jpg') ? 'image/jpeg' : 'image/png';
    return `data:${mime};base64,${b64}`;
}

/**
 * Approved fine report PDF — redesigned Vehicle Fine Report layout on VITS letterhead.
 * Title follows the fine type. Discount is an AED amount.
 */
export function buildFineApprovedPdfHtml({
    fine,
    assigned,
    formSummary,
    employeeName,
    hodName,
    signatureUrls,
}) {
    const bgUrl = getLetterheadDataUrl();

    const fields = buildAssetLossFineEmailFields(fine, {
        employeeName: employeeName || assigned?.employeeName,
        hodName: hodName || formSummary?.employeeStats?.hodName,
        assignedEmployeeId: assigned?.employeeId,
        fineSummaries: formSummary || {},
    });

    const formHtml = buildApprovedFineReportInnerHtml(fields, {
        signatureUrls,
        includeSignatures: true,
        includeAcknowledgement: true,
        includeFooter: true,
        rawPayableAmount: fields.yourFinePayment,
    });

    const letterheadLayer = bgUrl
        ? `<div class="vits-fine-letterhead" aria-hidden="true">
             <img src="${esc(bgUrl)}" alt="" />
           </div>`
        : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${esc(fields.reportTitle || 'Fine Report')} — ${esc(fine.fineId)}</title>
<style>
  @page { size: A4 portrait; margin: 0; }
  html, body {
    margin: 0;
    padding: 0;
    background: #ffffff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  #fine-approved-pdf,
  #fine-approved-pdf * {
    box-sizing: border-box;
  }
  #fine-approved-pdf {
    position: relative;
    width: 210mm;
    min-height: 297mm;
    margin: 0 auto;
    padding: ${SAFE_TOP} ${SAFE_X} ${SAFE_BOTTOM};
    font-family: Arial, Helvetica, sans-serif;
    color: #1e293b;
    line-height: 1.35;
    background: #ffffff;
    overflow: hidden;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .vits-fine-letterhead {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: 0;
    pointer-events: none;
    overflow: hidden;
  }
  .vits-fine-letterhead img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: fill;
    object-position: center top;
  }
  .vits-fine-content {
    position: relative;
    z-index: 1;
    width: 100%;
  }
  @media print {
    html, body { margin: 0 !important; padding: 0 !important; }
    #fine-approved-pdf {
      box-shadow: none !important;
      border: none !important;
    }
  }
</style>
</head>
<body>
<div id="fine-approved-pdf" data-fine-approved-ready="true">
  ${letterheadLayer}
  <div class="vits-fine-content">
    ${formHtml}
  </div>
</div>
</body>
</html>`;
}
