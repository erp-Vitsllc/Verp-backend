import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import {
    buildEmployeeAssetListRows,
    formatAssetListDate,
} from './buildEmployeeAssetListPdfHtml.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BG_IMAGE_PATH = path.join(__dirname, '../assets/templates/asset-list-page-bg.jpg');

const PAGE_WIDTH = 595.92;
const PAGE_HEIGHT = 934.56;
const BLACK = rgb(0, 0, 0);
const LINE = rgb(0, 0, 0);

/** Measured from asset-list-template.pdf */
const LAYOUT = {
    infoTable: {
        x: 56,
        yTop: 798,
        width: 483,
        rowHeight: 25,
    },
    table: {
        x: 56,
        width: 483,
        headerTop: 703,
        headerRowHeight: 11,
        headerHeight: 22,
        firstRowTop: 681,
        defaultRowHeight: 22,
        accLineHeight: 11,
        bottomLimit: 155,
        colX: [56, 108, 188, 258, 332, 392, 468, 539],
    },
};

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

function formatMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0.00';
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function truncate(text, max = 28) {
    const s = String(text ?? '—');
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function rowHeightForAsset(row) {
    const accCount = row.accessories?.length || 0;
    if (accCount <= 1) return LAYOUT.table.defaultRowHeight;
    return Math.max(LAYOUT.table.defaultRowHeight, 10 + accCount * LAYOUT.table.accLineHeight);
}

function drawLine(page, x1, y1, x2, y2, thickness = 0.75) {
    page.drawLine({
        start: { x: x1, y: y1 },
        end: { x: x2, y: y2 },
        thickness,
        color: LINE,
    });
}

function drawRectBorder(page, x, y, width, height) {
    drawLine(page, x, y, x + width, y);
    drawLine(page, x, y - height, x + width, y - height);
    drawLine(page, x, y, x, y - height);
    drawLine(page, x + width, y, x + width, y - height);
}

function drawTextInCell(page, font, text, colStart, colEnd, rowTop, rowHeight, { align = 'center', size = 8, dy = 7 } = {}) {
    const value = truncate(text, align === 'left' ? 34 : 22);
    const textWidth = font.widthOfTextAtSize(value, size);
    const cellWidth = colEnd - colStart;
    let x = colStart + 4;
    if (align === 'center') x = colStart + (cellWidth - textWidth) / 2;
    if (align === 'right') x = colEnd - textWidth - 4;
    const y = rowTop - rowHeight + dy;
    page.drawText(value, { x, y, size, font, color: BLACK });
}

async function embedBackground(outputDoc) {
    if (!fs.existsSync(BG_IMAGE_PATH)) {
        throw new Error(`Asset list background missing: ${BG_IMAGE_PATH}`);
    }
    const bytes = fs.readFileSync(BG_IMAGE_PATH);
    const image = await outputDoc.embedJpg(bytes);
    return image;
}

function drawPageBackground(page, image) {
    page.drawImage(image, {
        x: 0,
        y: 0,
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
    });
}

function drawInfoTable(page, font, fontBold, header) {
    const { x, yTop, width, rowHeight } = LAYOUT.infoTable;
    const row1Top = yTop;
    const row2Top = yTop - rowHeight;
    const colW = width / 3;
    const colX = [x, x + colW, x + colW * 2, x + width];

    drawRectBorder(page, x, row1Top, width, rowHeight * 2);
    drawLine(page, x, row2Top, x + width, row2Top);
    drawLine(page, colX[1], row1Top, colX[1], row1Top - rowHeight * 2);
    drawLine(page, colX[2], row1Top, colX[2], row1Top - rowHeight * 2);

    const headers = ['Employee Name', 'HOD Name', 'Date'];
    const values = [header.employeeName, header.hodName, header.date];

    headers.forEach((label, i) => {
        drawTextInCell(page, fontBold, label, colX[i], colX[i + 1], row1Top, rowHeight, { size: 8 });
    });
    values.forEach((value, i) => {
        drawTextInCell(page, font, value, colX[i], colX[i + 1], row2Top, rowHeight, { size: 9 });
    });
}

function drawTableHeader(page, fontBold) {
    const { x, width, headerTop, headerRowHeight, headerHeight, colX } = LAYOUT.table;
    const headerBottom = headerTop - headerHeight;
    const subRowY = headerTop - headerRowHeight;

    drawRectBorder(page, x, headerTop, width, headerHeight);

    // Vertical dividers for Sl.no → Status span full header height (rowspan 2).
    for (let i = 1; i <= 5; i += 1) {
        drawLine(page, colX[i], headerTop, colX[i], headerBottom);
    }

    // Accessories area: horizontal split + Name | Price divider on sub-row only.
    drawLine(page, colX[5], subRowY, colX[7], subRowY);
    drawLine(page, colX[6], subRowY, colX[6], headerBottom);

    const mainLabels = [
        { text: 'Sl.no', col: 0 },
        { text: 'Asset Name', col: 1 },
        { text: 'Value (AED)', col: 2 },
        { text: 'Assigned Date', col: 3 },
        { text: 'Status', col: 4 },
    ];

    for (const label of mainLabels) {
        drawTextInCell(
            page,
            fontBold,
            label.text,
            colX[label.col],
            colX[label.col + 1],
            headerTop,
            headerHeight,
            { size: 7, dy: 8 },
        );
    }

    drawTextInCell(page, fontBold, 'Accessories', colX[5], colX[7], headerTop, headerRowHeight, { size: 7, dy: 3 });
    drawTextInCell(page, fontBold, 'Name', colX[5], colX[6], subRowY, headerRowHeight, { size: 7, dy: 3 });
    drawTextInCell(page, fontBold, 'Price (AED)', colX[6], colX[7], subRowY, headerRowHeight, { size: 7, dy: 3 });
}

function drawAssetRow(page, font, row, rowTop, rowHeight) {
    const { colX } = LAYOUT.table;
    const hasAcc = (row.accessories?.length || 0) > 0;

    drawRectBorder(page, colX[0], rowTop, colX[colX.length - 1] - colX[0], rowHeight);

    // Main columns + accessories outer border; split Name/Price only when accessories exist.
    for (let i = 1; i <= 5; i += 1) {
        drawLine(page, colX[i], rowTop, colX[i], rowTop - rowHeight);
    }
    if (hasAcc) {
        drawLine(page, colX[6], rowTop, colX[6], rowTop - rowHeight);
    }

    drawTextInCell(page, font, String(row.index + 1), colX[0], colX[1], rowTop, rowHeight);
    drawTextInCell(page, font, row.name, colX[1], colX[2], rowTop, rowHeight, { align: 'left' });
    drawTextInCell(page, font, formatMoney(row.value), colX[2], colX[3], rowTop, rowHeight);
    drawTextInCell(page, font, formatAssetListDate(row.assignedDate), colX[3], colX[4], rowTop, rowHeight);
    drawTextInCell(page, font, row.status, colX[4], colX[5], rowTop, rowHeight);

    if (!hasAcc) {
        drawTextInCell(page, font, 'NO ACC', colX[5], colX[7], rowTop, rowHeight, { size: 8 });
    } else {
        row.accessories.forEach((acc, idx) => {
            const lineTop = rowTop - idx * LAYOUT.table.accLineHeight;
            drawTextInCell(
                page,
                font,
                `${idx + 1}. ${acc.name}`,
                colX[5],
                colX[6],
                lineTop,
                LAYOUT.table.accLineHeight + 2,
                { align: 'left', size: 7, dy: 3 },
            );
            drawTextInCell(
                page,
                font,
                formatMoney(acc.price),
                colX[6],
                colX[7],
                lineTop,
                LAYOUT.table.accLineHeight + 2,
                { size: 7, dy: 3 },
            );
        });
    }
}

function drawTotalRow(page, fontBold, rowTop, total) {
    const { colX } = LAYOUT.table;
    const rowHeight = 18;
    const tableWidth = colX[colX.length - 1] - colX[0];

    drawRectBorder(page, colX[0], rowTop, tableWidth, rowHeight);
    // Sl.no + Asset Name merged | Value | remaining columns merged
    drawLine(page, colX[2], rowTop, colX[2], rowTop - rowHeight);
    drawLine(page, colX[3], rowTop, colX[3], rowTop - rowHeight);

    const totalLabel = 'Total';
    const labelWidth = fontBold.widthOfTextAtSize(totalLabel, 8);
    page.drawText(totalLabel, {
        x: colX[2] - labelWidth - 8,
        y: rowTop - rowHeight + 6,
        size: 8,
        font: fontBold,
        color: BLACK,
    });
    drawTextInCell(page, fontBold, formatMoney(total), colX[2], colX[3], rowTop, rowHeight);
}

function paginateRows(listRows) {
    const pages = [];
    let current = [];
    let y = LAYOUT.table.firstRowTop;

    for (let i = 0; i < listRows.length; i += 1) {
        const row = { ...listRows[i], index: i };
        const h = rowHeightForAsset(row);
        const needsTotal = i === listRows.length - 1;
        const totalSpace = needsTotal ? 18 : 0;
        if (y - h - totalSpace < LAYOUT.table.bottomLimit) {
            pages.push(current);
            current = [];
            y = LAYOUT.table.firstRowTop;
        }
        current.push({ row, rowTop: y, rowHeight: h });
        y -= h;
    }

    if (current.length || pages.length === 0) pages.push(current);
    return pages;
}

/**
 * Build ASSET LIST PDF: template background image + transparent overlay table (dynamic rows).
 */
export async function generateEmployeeAssetListFromTemplatePdf({ employee, assets }) {
    try {
        const outputDoc = await PDFDocument.create();
        const font = await outputDoc.embedFont(StandardFonts.Helvetica);
        const fontBold = await outputDoc.embedFont(StandardFonts.HelveticaBold);
        const bgImage = await embedBackground(outputDoc);

        const listRows = buildEmployeeAssetListRows(assets);
        const header = {
            date: formatAssetListDate(new Date()),
            employeeName: employeeDisplayName(employee),
            hodName: resolveHodName(employee),
        };

        const total = listRows.reduce((sum, row) => {
            const accTotal = (row.accessories || []).reduce((s, acc) => s + (Number(acc.price) || 0), 0);
            return sum + (Number(row.value) || 0) + accTotal;
        }, 0);

        const pages = paginateRows(listRows);

        pages.forEach((pageRows, pageIndex) => {
            const page = outputDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
            drawPageBackground(page, bgImage);

            page.drawText('ASSET LIST', {
                x: 238,
                y: 828,
                size: 16,
                font: fontBold,
                color: BLACK,
            });

            drawInfoTable(page, font, fontBold, header);
            drawTableHeader(page, fontBold);

            if (pageRows.length === 0 && pageIndex === 0) {
                const rowTop = LAYOUT.table.firstRowTop;
                const rowHeight = LAYOUT.table.defaultRowHeight;
                drawAssetRow(
                    page,
                    font,
                    { index: 0, name: 'No assets assigned', value: 0, assignedDate: null, status: '—', accessories: [] },
                    rowTop,
                    rowHeight,
                );
                drawTotalRow(page, fontBold, rowTop - rowHeight, 0);
                return;
            }

            pageRows.forEach(({ row, rowTop, rowHeight }) => {
                drawAssetRow(page, font, row, rowTop, rowHeight);
            });

            const isLastPage = pageIndex === pages.length - 1;
            if (isLastPage) {
                const last = pageRows[pageRows.length - 1];
                const totalTop = last ? last.rowTop - last.rowHeight : LAYOUT.table.firstRowTop - LAYOUT.table.defaultRowHeight;
                drawTotalRow(page, fontBold, totalTop, total);
            }
        });

        const pdfBytes = await outputDoc.save();
        return Buffer.from(pdfBytes);
    } catch (err) {
        console.error('[generateEmployeeAssetListFromTemplatePdf]', err?.message || err);
        return null;
    }
}
