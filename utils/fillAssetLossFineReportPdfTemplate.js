import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
    amountToWords,
    buildAssetLossFineEmailFields,
    formatMoney,
} from './buildAssetLossFineEmailFields.js';
import { loadSignatureImageBytes } from './loadSignatureImageBytes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ASSET_LOSS_FINE_REPORT_TEMPLATE_PATH = path.join(
    __dirname,
    '../assets/templates/AssetLossFineReport-template.pdf',
);

/**
 * Text anchors on the template (PDF points, origin bottom-left).
 * cx = horizontal centre of value column; y = text baseline on the template row.
 */
const FIELD_LAYOUT = {
    fineId: { cx: 225, y: 768, size: 9, maxWidth: 128 },
    reportDate: { cx: 485, y: 768, size: 9, maxWidth: 100 },
    employeeName: { cx: 225, y: 743, size: 9, maxWidth: 128 },
    hodName: { cx: 485, y: 743, size: 9, maxWidth: 128 },
    description: { x: 140, y: 722, size: 9, maxWidth: 400, align: 'left' },
    assetPurchaseDate: { cx: 225, y: 662, size: 9, maxWidth: 128 },
    assetPurchaseCost: { cx: 485, y: 662, size: 9, maxWidth: 100 },
    assetAging: { cx: 225, y: 628, size: 9, maxWidth: 128 },
    fineCategory: { cx: 485, y: 628, size: 9, maxWidth: 100 },
    actualFine: { cx: 225, y: 596, size: 9, maxWidth: 128 },
    serviceCharge: { cx: 485, y: 596, size: 9, maxWidth: 100 },
    totalPayableFine: { cx: 225, y: 564, size: 9, maxWidth: 128 },
    payableTypeLabel: { cx: 485, y: 564, size: 9, maxWidth: 100 },
    yourFinePayment: { cx: 225, y: 533, size: 9, maxWidth: 128 },
    othersPayment: { cx: 485, y: 533, size: 9, maxWidth: 100 },
    monthlyDeduction: { cx: 225, y: 499, size: 9, maxWidth: 128 },
    sourceOfDeduction: { cx: 485, y: 499, size: 9, maxWidth: 100 },
    deductionStart: { cx: 225, y: 467, size: 9, maxWidth: 128 },
    deductionEnd: { cx: 485, y: 467, size: 9, maxWidth: 100 },
    ackEmployeeName: { x: 119, y: 432, size: 9, maxWidth: 74, align: 'left' },
    ackAmountWords: { x: 432, y: 414, size: 8, maxWidth: 102, align: 'left' },
};

/** Signature image area below each header cell (no white mask). */
const SIGNATURE_LAYOUT = {
    employee: { x: 60, y: 278, width: 114, height: 50 },
    hod: { x: 180, y: 278, width: 114, height: 50 },
    hr: { x: 300, y: 278, width: 114, height: 50 },
    accounts: { x: 420, y: 278, width: 114, height: 50 },
};

function truncateToWidth(text, font, size, maxWidth) {
    let value = String(text ?? '').trim();
    if (!value) return '';
    while (value.length > 0 && font.widthOfTextAtSize(value, size) > maxWidth) {
        value = value.slice(0, -1);
    }
    return value;
}

function drawField(page, font, layout, text) {
    const size = layout.size || 9;
    const value = truncateToWidth(text, font, size, layout.maxWidth);
    if (!value) return;

    const textWidth = font.widthOfTextAtSize(value, size);
    let x;
    if (layout.align === 'left' || layout.x != null) {
        x = layout.x ?? layout.cx - textWidth / 2;
    } else {
        x = (layout.cx ?? 0) - textWidth / 2;
    }

    page.drawText(value, {
        x,
        y: layout.y,
        size,
        font,
        color: rgb(0, 0, 0),
    });
}

/** Cover only the template underscore placeholders in the acknowledgement line. */
function coverAckPlaceholder(page, x, y, width, height = 13) {
    page.drawRectangle({
        x,
        y: y - 2,
        width,
        height,
        color: rgb(1, 1, 1),
        borderWidth: 0,
    });
}

async function embedSignature(page, pdfDoc, sigMeta, layout) {
    const sig = sigMeta?.signature || sigMeta;
    if (!sig && !sigMeta?.url) return;

    try {
        let bytes = await loadSignatureImageBytes(sig || { url: sigMeta.url }, sigMeta.employeeId);
        if (!bytes?.length) {
            console.warn(
                '[fillAssetLossFineReportPdfTemplate] No signature image for',
                sigMeta?.name || 'unknown',
            );
            return;
        }

        let image;
        try {
            image = await pdfDoc.embedPng(bytes);
        } catch {
            image = await pdfDoc.embedJpg(bytes);
        }

        const scale = Math.min(layout.width / image.width, layout.height / image.height) * 0.95;
        const w = image.width * scale;
        const h = image.height * scale;
        page.drawImage(image, {
            x: layout.x + (layout.width - w) / 2,
            y: layout.y + (layout.height - h) / 2,
            width: w,
            height: h,
        });
    } catch (err) {
        console.warn(
            '[fillAssetLossFineReportPdfTemplate] signature embed failed:',
            sigMeta?.name || 'unknown',
            err?.message || err,
        );
    }
}

/**
 * Fills the official Asset Loss Fine Report PDF template with dynamic data and signatures.
 */
export async function fillAssetLossFineReportPdfTemplate({
    fine,
    assigned,
    formSummary,
    employeeName,
    hodName,
    signatureUrls,
}) {
    if (!fs.existsSync(ASSET_LOSS_FINE_REPORT_TEMPLATE_PATH)) {
        throw new Error(`Asset Loss Fine Report template not found at ${ASSET_LOSS_FINE_REPORT_TEMPLATE_PATH}`);
    }

    const templateBytes = fs.readFileSync(ASSET_LOSS_FINE_REPORT_TEMPLATE_PATH);
    const pdfDoc = await PDFDocument.load(templateBytes);
    const page = pdfDoc.getPages()[0];
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const raw = buildAssetLossFineEmailFields(fine, {
        employeeName: employeeName || assigned?.employeeName,
        hodName: hodName || formSummary?.employeeStats?.hodName,
        assignedEmployeeId: assigned?.employeeId,
        fineSummaries: formSummary || {},
    });

    const fields = {
        fineId: raw.fineId,
        reportDate: raw.reportDate,
        employeeName: raw.employeeName,
        hodName: raw.hodName,
        description: raw.description,
        assetPurchaseDate: raw.assetPurchaseDate,
        assetPurchaseCost: `${formatMoney(raw.assetPurchaseCost)} AED`,
        assetAging: raw.assetAging,
        fineCategory: raw.fineCategory,
        actualFine: `${formatMoney(raw.actualFineAmount)} AED`,
        serviceCharge: `${formatMoney(raw.serviceCharge)} AED`,
        totalPayableFine: `${formatMoney(raw.totalFine)} AED`,
        payableTypeLabel: raw.payableTypeLabel,
        yourFinePayment: `${formatMoney(raw.yourFinePayment)} AED`,
        othersPayment: `${formatMoney(raw.othersPayment)} AED`,
        monthlyDeduction: `${formatMoney(raw.monthlyDeduction)} AED`,
        sourceOfDeduction: raw.sourceOfDeduction,
        deductionStart: raw.deductionStart,
        deductionEnd: raw.deductionEnd,
        ackEmployeeName: raw.employeeName,
        ackAmountWords: `${amountToWords(raw.yourFinePayment)} DIRHAMS`,
    };

    coverAckPlaceholder(page, 116, 432, 78);
    coverAckPlaceholder(page, 429, 414, 104);

    for (const [key, value] of Object.entries(fields)) {
        const layout = FIELD_LAYOUT[key];
        if (layout) drawField(page, font, layout, value);
    }

    const sigEntries = [
        { meta: signatureUrls?.employee, layout: SIGNATURE_LAYOUT.employee },
        { meta: signatureUrls?.hod, layout: SIGNATURE_LAYOUT.hod },
        { meta: signatureUrls?.hr, layout: SIGNATURE_LAYOUT.hr },
        { meta: signatureUrls?.accounts, layout: SIGNATURE_LAYOUT.accounts },
    ];

    for (const { meta, layout } of sigEntries) {
        await embedSignature(page, pdfDoc, meta, layout);
    }

    return Buffer.from(await pdfDoc.save());
}
