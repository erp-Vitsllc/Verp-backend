import fs from 'fs';
import {
    amountToWords,
    buildAssetLossFineEmailFields,
    formatMoney,
} from './buildAssetLossFineEmailFields.js';
import {
    ASSET_LOSS_FINE_REPORT_LETTERHEAD_PATH,
    ASSET_LOSS_FINE_REPORT_PDF_SELECTOR,
    ASSET_LOSS_FINE_REPORT_VALUE_COLOR,
} from './assetLossFineReportConstants.js';

const BORDER = '1px solid #000000';
const VALUE_COLOR = ASSET_LOSS_FINE_REPORT_VALUE_COLOR;
const TD_LABEL =
    `padding:8px 10px;border:${BORDER};font-weight:bold;font-size:12px;color:#000;background:rgba(255,255,255,0.25);`;
const TD_VAL =
    `padding:8px 10px;border:${BORDER};text-align:center;font-weight:bold;font-size:12px;color:${VALUE_COLOR};background:rgba(255,255,255,0.12);`;

function esc(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function getLetterheadDataUrl() {
    if (!fs.existsSync(ASSET_LOSS_FINE_REPORT_LETTERHEAD_PATH)) return '';
    const b64 = fs.readFileSync(ASSET_LOSS_FINE_REPORT_LETTERHEAD_PATH).toString('base64');
    return `data:image/png;base64,${b64}`;
}

function sigBox(label, sig) {
    const name = sig?.name ? esc(sig.name) : '';
    const url = sig?.url ? esc(sig.url) : '';
    const img = url
        ? `<img src="${url}" alt="" style="max-height:52px;max-width:200px;object-fit:contain;display:block;margin:6px auto 0;" />`
        : `<div style="min-height:52px;margin-top:6px;border-bottom:1px solid #333;max-width:200px;margin-left:auto;margin-right:auto;"></div>`;
    return `<td width="25%" valign="top" style="padding:8px;border:${BORDER};text-align:center;background:rgba(255,255,255,0.2);font-size:11px;">
        <div style="font-weight:bold;margin-bottom:4px;">${esc(label)}</div>
        ${img}
        ${name ? `<div style="font-size:10px;margin-top:4px;color:#333;">${name}</div>` : ''}
    </td>`;
}

function buildFormTable(fields, signatureUrls) {
    const amountWords = amountToWords(fields.yourFinePayment);
    const employeeLabel = fields.employeeName;

    return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:transparent;border:2px solid #000000;">
        <tr>
            <td colspan="4" style="padding:12px;border:${BORDER};text-align:center;font-size:16px;font-weight:bold;background:rgba(255,255,255,0.3);">
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
            <td style="${TD_VAL}">${esc(fields.assetPurchaseCost)} AED</td>
        </tr>
        <tr>
            <td style="${TD_LABEL}">Asset Aging</td>
            <td style="${TD_VAL}">${esc(fields.assetAging)}</td>
            <td style="${TD_LABEL}">Fine Type</td>
            <td style="${TD_VAL}">${esc(fields.fineCategory)}</td>
        </tr>
        <tr>
            <td style="${TD_LABEL}">Actual Fine</td>
            <td style="${TD_VAL}">${esc(fields.actualFine)} AED</td>
            <td style="${TD_LABEL}">Service Charge</td>
            <td style="${TD_VAL}">${esc(fields.serviceCharge)} AED</td>
        </tr>
        <tr>
            <td style="${TD_LABEL}">Total Payable Fine</td>
            <td style="${TD_VAL}">${esc(fields.totalPayableFine)} AED</td>
            <td style="${TD_LABEL}">Payable Type</td>
            <td style="${TD_VAL}">${esc(fields.payableTypeLabel)}</td>
        </tr>
        <tr>
            <td style="${TD_LABEL}">Your Fine payment</td>
            <td style="${TD_VAL}">${esc(fields.yourFinePayment)} AED</td>
            <td style="${TD_LABEL}">Others Payment</td>
            <td style="${TD_VAL}">${esc(fields.othersPayment)} AED</td>
        </tr>
        <tr>
            <td style="${TD_LABEL}">Amount Deduct Per month</td>
            <td style="${TD_VAL}">${esc(fields.monthlyDeduction)} AED</td>
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
            <td colspan="4" style="padding:12px 14px;border:${BORDER};font-size:12px;line-height:1.6;color:#000;background:rgba(255,255,255,0.25);">
                I <strong>${esc(employeeLabel)}</strong> acknowledge that the fine mentioned above has been committed due to my responsibility.
                I understand and accept that I am accountable for the amount of
                <strong>(${esc(amountWords)} DIRHAMS)</strong>.
                I hereby authorize the deduction of the specified amount as mentioned from the source of income.
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

/**
 * HTML document for the Asset Loss Fine Report PDF (dynamic red fields + digital signatures).
 */
export function buildAssetLossFineReportPdfHtml({
    fine,
    assigned,
    formSummary,
    employeeName,
    hodName,
    signatureUrls,
}) {
    const rawFields = buildAssetLossFineEmailFields(fine, {
        employeeName: employeeName || assigned?.employeeName,
        hodName: hodName || formSummary?.employeeStats?.hodName,
        assignedEmployeeId: assigned?.employeeId,
        fineSummaries: formSummary || {},
    });

    const fields = {
        ...rawFields,
        assetPurchaseCost: formatMoney(rawFields.assetPurchaseCost),
        actualFine: formatMoney(rawFields.actualFineAmount),
        serviceCharge: formatMoney(rawFields.serviceCharge),
        totalPayableFine: formatMoney(rawFields.totalFine),
        yourFinePayment: formatMoney(rawFields.yourFinePayment),
        othersPayment: formatMoney(rawFields.othersPayment),
        monthlyDeduction: formatMoney(rawFields.monthlyDeduction),
    };

    const bgUrl = getLetterheadDataUrl();
    const bgStyle = bgUrl
        ? `background-image:url(${JSON.stringify(bgUrl)});background-size:100% 100%;background-position:center;background-repeat:no-repeat;`
        : '';
    const selectorId = ASSET_LOSS_FINE_REPORT_PDF_SELECTOR.replace('#', '').split('[')[0];

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Asset Loss Fine Report — ${esc(fine.fineId)}</title>
<style>
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body style="margin:0;background:#fff;">
<div id="${selectorId}" data-asset-loss-fine-report-ready="true" style="box-sizing:border-box;max-width:210mm;margin:0 auto;padding:138px 44px 128px 44px;font-family:Georgia,'Times New Roman',serif;color:#333;line-height:1.45;min-height:297mm;${bgStyle}-webkit-print-color-adjust:exact;print-color-adjust:exact;">
  ${buildFormTable(fields, signatureUrls)}
</div>
</body>
</html>`;
}
