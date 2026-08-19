import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
    buildAssetLossFineAcknowledgementText,
    buildAssetLossFineEmailFields,
    formatMoney,
    reportTitleForFine,
} from './buildAssetLossFineEmailFields.js';
import { loadSignatureImageBytes } from './loadSignatureImageBytes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const FINE_REPORT_REDESIGNED_TEMPLATE_PATH = path.join(
    __dirname,
    '../assets/templates/FineReport-redesigned.pdf',
);

const NAVY = rgb(23 / 255, 59 / 255, 99 / 255);
const INK = rgb(30 / 255, 41 / 255, 59 / 255);
const WHITE = rgb(1, 1, 1);

function cover(page, x, y, width, height, color = WHITE) {
    page.drawRectangle({ x, y, width, height, color, borderWidth: 0 });
}

function fitText(text, font, size, maxWidth) {
    let value = String(text ?? '').trim();
    if (!value) return '';
    while (value.length > 1 && font.widthOfTextAtSize(value, size) > maxWidth) {
        value = value.slice(0, -1);
    }
    return value;
}

function wrapLines(text, font, size, maxWidth) {
    const words = String(text || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const lines = [];
    let current = '';
    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
            current = candidate;
        } else {
            if (current) lines.push(current);
            current = word;
        }
    }
    if (current) lines.push(current);
    return lines;
}

function drawLeft(page, font, text, x, y, size, maxWidth, color = INK) {
    const value = fitText(text, font, size, maxWidth);
    if (!value) return;
    page.drawText(value, { x, y, size, font, color });
}

async function embedSignature(page, pdfDoc, sigMeta, layout) {
    if (!sigMeta) return;
    try {
        const sig = sigMeta?.signature || sigMeta;
        const bytes = await loadSignatureImageBytes(sig || { url: sigMeta.url }, sigMeta.employeeId);
        if (!bytes?.length) return;
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
    } catch {
        // keep template signature area empty if the image cannot be embedded
    }
}

/**
 * Fills the user-provided redesigned fine report PDF. Layout/artwork stay exact;
 * only values, type title, and discount amount are written on top.
 */
export async function fillFineRedesignedReportPdf({
    fine,
    assigned,
    formSummary,
    employeeName,
    hodName,
    signatureUrls,
}) {
    if (!fs.existsSync(FINE_REPORT_REDESIGNED_TEMPLATE_PATH)) {
        return null;
    }

    const templateBytes = fs.readFileSync(FINE_REPORT_REDESIGNED_TEMPLATE_PATH);
    const pdfDoc = await PDFDocument.load(templateBytes);
    const page = pdfDoc.getPages()[0];
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const raw = buildAssetLossFineEmailFields(fine, {
        employeeName: employeeName || assigned?.employeeName,
        hodName: hodName || formSummary?.employeeStats?.hodName,
        assignedEmployeeId: assigned?.employeeId,
        fineSummaries: formSummary || {},
    });

    const title = reportTitleForFine(fine);
    cover(page, 90, 716, 328, 24, NAVY);
    let titleSize = 17;
    while (titleSize > 10 && fontBold.widthOfTextAtSize(title, titleSize) > 320) {
        titleSize -= 0.5;
    }
    page.drawText(title, {
        x: 96.4,
        y: 720.9,
        size: titleSize,
        font: fontBold,
        color: WHITE,
    });

    cover(page, 424, 708, 82, 18, NAVY);
    drawLeft(page, fontBold, String(raw.fineCategory || 'Single Fine').toUpperCase(), 428, 713.5, 7.5, 76, WHITE);

    cover(page, 77, 658, 210, 14);
    drawLeft(page, fontBold, raw.fineId, 77, 661, 9.1, 205);

    cover(page, 312, 658, 208, 14);
    drawLeft(page, fontBold, raw.reportDate, 312.3, 661, 9.1, 200);

    cover(page, 77, 615, 210, 16);
    drawLeft(page, fontBold, raw.employeeName, 77, 618.4, 9.1, 205);

    cover(page, 312, 615, 208, 16);
    drawLeft(page, fontBold, raw.hodName, 312.3, 618.4, 9.1, 200);

    cover(page, 78, 552, 442, 32);
    const descLines = wrapLines(raw.description, font, 9.2, 430).slice(0, 2);
    let descY = 570.4;
    for (const line of descLines) {
        page.drawText(line, { x: 78, y: descY, size: 9.2, font, color: INK });
        descY -= 12;
    }

    cover(page, 188, 507, 108, 12);
    drawLeft(page, fontBold, `${formatMoney(raw.actualFineAmount)} AED`, 195.9, 510.4, 7.7, 100);

    cover(page, 418, 507, 100, 12);
    drawLeft(page, fontBold, `${formatMoney(raw.serviceCharge)} AED`, 425.5, 510.4, 7.7, 90);

    cover(page, 188, 490, 108, 12);
    drawLeft(page, fontBold, `${formatMoney(raw.discount)} AED`, 195.9, 492.8, 7.7, 100);

    cover(page, 418, 490, 100, 12);
    drawLeft(page, fontBold, `${formatMoney(raw.totalFine)} AED`, 425.5, 492.8, 7.7, 90);

    cover(page, 188, 473, 320, 12);
    drawLeft(page, fontBold, raw.payableTypeLabel, 195.9, 475.3, 7.7, 310);

    cover(page, 400, 432, 122, 18);
    drawLeft(page, fontBold, `AED ${formatMoney(raw.totalFine)}`, 447.4, 437.1, 13, 78, NAVY);

    cover(page, 188, 407, 108, 12);
    drawLeft(page, fontBold, `${formatMoney(raw.monthlyDeduction)} AED`, 195.9, 410.3, 7.7, 100);

    cover(page, 418, 407, 100, 12);
    drawLeft(page, fontBold, raw.sourceOfDeduction, 425.5, 410.3, 7.7, 90);

    cover(page, 188, 390, 108, 12);
    drawLeft(page, fontBold, raw.deductionStart, 195.9, 392.7, 7.7, 100);

    cover(page, 418, 390, 100, 12);
    drawLeft(page, fontBold, raw.deductionEnd, 425.5, 392.7, 7.7, 90);

    cover(page, 75, 324, 450, 38);
    const ack = buildAssetLossFineAcknowledgementText(raw.employeeName, raw.yourFinePayment);
    const ackLines = wrapLines(ack, font, 8.1, 448).slice(0, 3);
    let ackY = 350.3;
    for (const line of ackLines) {
        page.drawText(line, { x: 78, y: ackY, size: 8.1, font, color: INK });
        ackY -= 11.1;
    }

    cover(page, 77, 198, 118, 22);
    cover(page, 200, 198, 118, 22);
    cover(page, 318, 198, 118, 22);
    cover(page, 440, 198, 90, 22);

    const sigNames = [
        { text: raw.employeeName, x: 90.7, max: 110 },
        { text: raw.hodName, x: 209.7, max: 110 },
        { text: signatureUrls?.hr?.name || '', x: 326.6, max: 110 },
        { text: signatureUrls?.accounts?.name || '', x: 452.4, max: 80 },
    ];
    for (const item of sigNames) {
        const lines = wrapLines(item.text, font, 6.8, item.max).slice(0, 2);
        let y = 211.3;
        for (const line of lines) {
            page.drawText(line, { x: item.x, y, size: 6.8, font, color: INK });
            y -= 8;
        }
    }

    await embedSignature(page, pdfDoc, signatureUrls?.employee, { x: 77, y: 222, width: 114, height: 55 });
    await embedSignature(page, pdfDoc, signatureUrls?.hod, { x: 200, y: 222, width: 114, height: 55 });
    await embedSignature(page, pdfDoc, signatureUrls?.hr, { x: 320, y: 222, width: 114, height: 55 });
    await embedSignature(page, pdfDoc, signatureUrls?.accounts, { x: 440, y: 222, width: 114, height: 55 });

    cover(page, 68, 184, 250, 12);
    drawLeft(page, font, `Document reference: ${raw.fineId}`, 68, 187.7, 6.7, 248);

    return Buffer.from(await pdfDoc.save());
}
