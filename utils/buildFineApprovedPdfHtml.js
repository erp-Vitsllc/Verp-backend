import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    buildAssetLossFineAcknowledgementHtml,
    buildAssetLossFineEmailFields,
    formatMoney,
    isLossDamageFineType,
} from './buildAssetLossFineEmailFields.js';

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

const VALUE_COLOR = '#cc0000';
const BORDER = '1px solid #000000';
const ACK_CELL_STYLE =
    `padding:12px 14px;border:${BORDER};font-size:11px;line-height:1.65;color:#000;background:transparent;` +
    'word-wrap:break-word;overflow-wrap:break-word;white-space:normal;text-align:justify;hyphens:auto;';
const TD_LABEL =
    `padding:8px 10px;border:${BORDER};font-weight:bold;font-size:12px;color:#000;background:transparent;`;
const TD_VAL =
    `padding:8px 10px;border:${BORDER};text-align:center;font-weight:bold;font-size:12px;color:${VALUE_COLOR};background:transparent;`;

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

function sigBox(label, sig) {
    const name = sig?.name ? esc(sig.name) : '';
    const url = sig?.url ? esc(sig.url) : '';
    const img = url
        ? `<img src="${url}" alt="" style="max-height:52px;max-width:200px;object-fit:contain;display:block;margin:6px auto 0;" />`
        : `<div style="min-height:52px;margin-top:6px;border-bottom:1px solid #333;max-width:200px;margin-left:auto;margin-right:auto;"></div>`;
    return `<td width="25%" valign="top" style="padding:8px;border:${BORDER};text-align:center;background:transparent;font-size:11px;">
        <div style="font-weight:bold;margin-bottom:4px;">${esc(label)}</div>
        ${img}
        ${name ? `<div style="font-size:10px;margin-top:4px;color:#333;">${name}</div>` : ''}
    </td>`;
}

function buildAssetLossFormTable(fields, signatureUrls, rawPayableAmount) {
    const ackHtml = buildAssetLossFineAcknowledgementHtml(fields.employeeName, rawPayableAmount, {
        valueColor: VALUE_COLOR,
    });

    return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:transparent;border:2px solid #000000;">
        <tr>
            <td colspan="4" style="padding:12px;border:${BORDER};text-align:center;font-size:16px;font-weight:bold;background:transparent;">
                Asset Loss Fine Report
            </td>
        </tr>
        <tr>
            <td style="${TD_LABEL}">Fine No</td>
            <td style="${TD_VAL}">${esc(fields.fineId)}</td>
            <td style="${TD_LABEL}">Date</td>
            <td style="${TD_VAL}">${esc(fields.reportDate)}</td>
        </tr>
        <tr>
            <td style="${TD_LABEL}">Employee Name</td>
            <td style="${TD_VAL}">${esc(fields.employeeName)}</td>
            <td style="${TD_LABEL}">HOD Name</td>
            <td style="${TD_VAL}">${esc(fields.hodName)}</td>
        </tr>
        <tr>
            <td style="${TD_LABEL}">Fine Discription:-</td>
            <td colspan="3" style="${TD_VAL}">${esc(fields.description)}</td>
        </tr>
        <tr>
            <td style="${TD_LABEL}">Asset Purchase Date</td>
            <td style="${TD_VAL}">${esc(fields.assetPurchaseDate)}</td>
            <td style="${TD_LABEL}">Asset Purchase Cost</td>
            <td style="${TD_VAL}">${esc(`${formatMoney(fields.assetPurchaseCost)} AED`)}</td>
        </tr>
        <tr>
            <td style="${TD_LABEL}">Asset Aging</td>
            <td style="${TD_VAL}">${esc(fields.assetAging)}</td>
            <td style="${TD_LABEL}">Fine Type</td>
            <td style="${TD_VAL}">${esc(fields.fineCategory)}</td>
        </tr>
        <tr>
            <td style="${TD_LABEL}">Actual Fine</td>
            <td style="${TD_VAL}">${esc(`${formatMoney(fields.actualFineAmount)} AED`)}</td>
            <td style="${TD_LABEL}">Service Charge</td>
            <td style="${TD_VAL}">${esc(`${formatMoney(fields.serviceCharge)} AED`)}</td>
        </tr>
        <tr>
            <td style="${TD_LABEL}">Total Payable Fine</td>
            <td style="${TD_VAL}">${esc(`${formatMoney(fields.totalFine)} AED`)}</td>
            <td style="${TD_LABEL}">Payable Type</td>
            <td style="${TD_VAL}">${esc(fields.payableTypeLabel)}</td>
        </tr>
        <tr>
            <td style="${TD_LABEL}">Your Fine payment</td>
            <td style="${TD_VAL}">${esc(`${formatMoney(fields.yourFinePayment)} AED`)}</td>
            <td style="${TD_LABEL}">Others Payment</td>
            <td style="${TD_VAL}">${esc(`${formatMoney(fields.othersPayment)} AED`)}</td>
        </tr>
        <tr>
            <td style="${TD_LABEL}">Amount Deduct Per month</td>
            <td style="${TD_VAL}">${esc(`${formatMoney(fields.monthlyDeduction)} AED`)}</td>
            <td style="${TD_LABEL}">Source OF deduction</td>
            <td style="${TD_VAL}">${esc(fields.sourceOfDeduction)}</td>
        </tr>
        <tr>
            <td style="${TD_LABEL}">Deduction Start Date</td>
            <td style="${TD_VAL}">${esc(fields.deductionStart)}</td>
            <td style="${TD_LABEL}">Deduction End Date</td>
            <td style="${TD_VAL}">${esc(fields.deductionEnd)}</td>
        </tr>
        <tr>
            <td colspan="4" style="${ACK_CELL_STYLE}">
                ${ackHtml}
            </td>
        </tr>
        <tr>
            ${sigBox('Employee signatue', signatureUrls?.employee)}
            ${sigBox('HOD Signature', signatureUrls?.hod)}
            ${sigBox('HR Officer', signatureUrls?.hr)}
            ${sigBox('Accounts', signatureUrls?.accounts)}
        </tr>
    </table>`;
}

function buildGenericFineFormTable(fine, employeeName, hodName, formSummary, signatureUrls) {
    const fineId = fine?.fineId || '';
    const fineType = fine?.fineType || '';
    const reportDate = formSummary?.reportDate || formSummary?.date || '';
    const description = fine?.description || fine?.companyDescription || fine?.reason || '';
    const total = fine?.totalFineAmount ?? fine?.fineAmount ?? '';
    const status = fine?.fineStatus || fine?.status || '';

    return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:transparent;border:2px solid #000000;">
        <tr>
            <td colspan="4" style="padding:12px;border:${BORDER};text-align:center;font-size:16px;font-weight:bold;background:transparent;">
                Fine Report
            </td>
        </tr>
        <tr>
            <td style="${TD_LABEL}">Fine No</td>
            <td style="${TD_VAL}">${esc(fineId)}</td>
            <td style="${TD_LABEL}">Date</td>
            <td style="${TD_VAL}">${esc(reportDate)}</td>
        </tr>
        <tr>
            <td style="${TD_LABEL}">Employee Name</td>
            <td style="${TD_VAL}">${esc(employeeName)}</td>
            <td style="${TD_LABEL}">HOD Name</td>
            <td style="${TD_VAL}">${esc(hodName)}</td>
        </tr>
        <tr>
            <td style="${TD_LABEL}">Fine Type</td>
            <td style="${TD_VAL}">${esc(fineType)}</td>
            <td style="${TD_LABEL}">Status</td>
            <td style="${TD_VAL}">${esc(status)}</td>
        </tr>
        <tr>
            <td style="${TD_LABEL}">Description</td>
            <td colspan="3" style="${TD_VAL}">${esc(description)}</td>
        </tr>
        <tr>
            <td style="${TD_LABEL}">Amount</td>
            <td colspan="3" style="${TD_VAL}">${esc(total !== '' ? `${formatMoney(total)} AED` : '')}</td>
        </tr>
        <tr>
            ${sigBox('Employee signatue', signatureUrls?.employee)}
            ${sigBox('HOD Signature', signatureUrls?.hod)}
            ${sigBox('HR Officer', signatureUrls?.hr)}
            ${sigBox('Accounts', signatureUrls?.accounts)}
        </tr>
    </table>`;
}

/**
 * Full fine-approved PDF document with VITS Abudhabi letterhead background.
 * Content sits in the safe inset so header/footer artwork is never overridden.
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

    let formHtml;
    if (isLossDamageFineType(fine)) {
        const rawFields = buildAssetLossFineEmailFields(fine, {
            employeeName: employeeName || assigned.employeeName,
            hodName: hodName || formSummary?.employeeStats?.hodName,
            assignedEmployeeId: assigned.employeeId,
            fineSummaries: formSummary || {},
        });
        formHtml = buildAssetLossFormTable(rawFields, signatureUrls, rawFields.yourFinePayment);
    } else {
        formHtml = buildGenericFineFormTable(
            fine,
            employeeName || assigned?.employeeName,
            hodName || formSummary?.employeeStats?.hodName,
            formSummary,
            signatureUrls,
        );
    }

    const letterheadLayer = bgUrl
        ? `<div class="vits-fine-letterhead" aria-hidden="true">
             <img src="${esc(bgUrl)}" alt="" />
           </div>`
        : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Fine Report — ${esc(fine.fineId)}</title>
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
    font-family: Georgia, 'Times New Roman', Times, serif;
    color: #000;
    line-height: 1.45;
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
  #fine-approved-pdf table,
  #fine-approved-pdf th,
  #fine-approved-pdf td {
    background: transparent !important;
    background-color: transparent !important;
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
