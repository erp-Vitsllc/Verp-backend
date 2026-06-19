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

/** Measured from asset-list-template.pdf — 6 columns: SL | Asset Name | Accessories | Asset ID | QTY | Value */
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
        headerHeight: 22,
        firstRowTop: 681,
        defaultRowHeight: 22,
        bottomLimit: 155,
        colX: [56, 88, 193, 338, 423, 458, 539],
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

const CELL_PAD_X = 4;
const CELL_PAD_Y = 4;
const LINE_GAP = 2;

function lineHeightForSize(size) {
    return size + LINE_GAP;
}

function wrapTextToLines(font, text, size, maxWidth) {
    const raw = String(text ?? '—').trim() || '—';
    if (maxWidth <= 0) return [raw];

    const lines = [];
    const words = raw.split(/\s+/).filter(Boolean);

    const pushLongWord = (word) => {
        let chunk = '';
        for (const ch of word) {
            const candidate = chunk + ch;
            if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
                chunk = candidate;
            } else {
                if (chunk) lines.push(chunk);
                chunk = ch;
            }
        }
        if (chunk) lines.push(chunk);
    };

    let current = '';
    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
            current = candidate;
            continue;
        }
        if (current) lines.push(current);
        if (font.widthOfTextAtSize(word, size) > maxWidth) {
            pushLongWord(word);
            current = '';
        } else {
            current = word;
        }
    }
    if (current) lines.push(current);
    return lines.length ? lines : ['—'];
}

function countWrappedLines(font, text, size, colStart, colEnd) {
    const maxWidth = colEnd - colStart - CELL_PAD_X * 2;
    return wrapTextToLines(font, text, size, maxWidth).length;
}

function cellHeightForLines(lineCount, size, minHeight) {
    const contentHeight = lineCount * lineHeightForSize(size) + CELL_PAD_Y * 2;
    return Math.max(minHeight, contentHeight);
}

function drawWrappedTextInCell(page, font, text, colStart, colEnd, rowTop, rowHeight, { align = 'center', size = 8 } = {}) {
    const maxWidth = colEnd - colStart - CELL_PAD_X * 2;
    const lines = wrapTextToLines(font, text, size, maxWidth);
    const lh = lineHeightForSize(size);
    const blockHeight = lines.length * lh;
    let y = rowTop - (rowHeight - blockHeight) / 2 - size;

    for (const line of lines) {
        const textWidth = font.widthOfTextAtSize(line, size);
        let x = colStart + CELL_PAD_X;
        if (align === 'center') x = colStart + (colEnd - colStart - textWidth) / 2;
        if (align === 'right') x = colEnd - textWidth - CELL_PAD_X;
        page.drawText(line, { x, y, size, font, color: BLACK });
        y -= lh;
    }

    return lines.length;
}

function countAccessoryListLines(font, accessories, colStart, colEnd) {
    if (!accessories?.length) {
        return countWrappedLines(font, 'NO ACC', 7, colStart, colEnd);
    }

    return accessories.reduce(
        (total, acc, idx) =>
            total + countWrappedLines(font, `${idx + 1}. ${acc.name}`, 7, colStart, colEnd),
        0,
    );
}

function drawAccessoryListInCell(page, font, accessories, colStart, colEnd, rowTop, rowHeight) {
    const size = 7;
    const maxWidth = colEnd - colStart - CELL_PAD_X * 2;
    const lh = lineHeightForSize(size);

    if (!accessories?.length) {
        drawWrappedTextInCell(page, font, 'NO ACC', colStart, colEnd, rowTop, rowHeight, { align: 'left', size });
        return;
    }

    const lines = accessories.flatMap((acc, idx) =>
        wrapTextToLines(font, `${idx + 1}. ${acc.name}`, size, maxWidth),
    );
    const blockHeight = lines.length * lh;
    let y = rowTop - (rowHeight - blockHeight) / 2 - size;

    for (const line of lines) {
        page.drawText(line, { x: colStart + CELL_PAD_X, y, size, font, color: BLACK });
        y -= lh;
    }
}

function rowHeightForAsset(row, font) {
    const { colX, defaultRowHeight } = LAYOUT.table;

    const slLines = 1;
    const nameLines = countWrappedLines(font, row.name, 8, colX[1], colX[2]);
    const accLines = countAccessoryListLines(font, row.accessories, colX[2], colX[3]);
    const assetIdLines = countWrappedLines(font, row.assetId, 8, colX[3], colX[4]);
    const qtyLines = countWrappedLines(font, String(row.quantity ?? 1), 8, colX[4], colX[5]);
    const valueLines = countWrappedLines(font, formatMoney(row.totalValue), 8, colX[5], colX[6]);

    return Math.max(
        defaultRowHeight,
        cellHeightForLines(slLines, 8, defaultRowHeight),
        cellHeightForLines(nameLines, 8, defaultRowHeight),
        cellHeightForLines(accLines, 7, defaultRowHeight),
        cellHeightForLines(assetIdLines, 8, defaultRowHeight),
        cellHeightForLines(qtyLines, 8, defaultRowHeight),
        cellHeightForLines(valueLines, 8, defaultRowHeight),
    );
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
    const { x, yTop, width } = LAYOUT.infoTable;
    const minRowHeight = LAYOUT.infoTable.rowHeight;
    const colW = width / 3;
    const colX = [x, x + colW, x + colW * 2, x + width];

    const headers = ['Employee Name', 'HOD Name', 'Date'];
    const values = [header.employeeName, header.hodName, header.date];

    const row1Height = Math.max(
        minRowHeight,
        ...headers.map((label, i) =>
            cellHeightForLines(countWrappedLines(fontBold, label, 8, colX[i], colX[i + 1]), 8, minRowHeight),
        ),
    );
    const row2Height = Math.max(
        minRowHeight,
        ...values.map((value, i) =>
            cellHeightForLines(countWrappedLines(font, value, 9, colX[i], colX[i + 1]), 9, minRowHeight),
        ),
    );

    const row1Top = yTop;
    const row2Top = yTop - row1Height;
    const totalHeight = row1Height + row2Height;

    drawRectBorder(page, x, row1Top, width, totalHeight);
    drawLine(page, x, row2Top, x + width, row2Top);
    drawLine(page, colX[1], row1Top, colX[1], row1Top - totalHeight);
    drawLine(page, colX[2], row1Top, colX[2], row1Top - totalHeight);

    headers.forEach((label, i) => {
        drawWrappedTextInCell(page, fontBold, label, colX[i], colX[i + 1], row1Top, row1Height, { size: 8 });
    });
    values.forEach((value, i) => {
        drawWrappedTextInCell(page, font, value, colX[i], colX[i + 1], row2Top, row2Height, { size: 9 });
    });
}

function drawTableHeader(page, fontBold) {
    const { x, width, headerTop, headerHeight, colX } = LAYOUT.table;
    const headerBottom = headerTop - headerHeight;

    drawRectBorder(page, x, headerTop, width, headerHeight);

    for (let i = 1; i <= 5; i += 1) {
        drawLine(page, colX[i], headerTop, colX[i], headerBottom);
    }

    const labels = [
        { text: 'SL', col: 0 },
        { text: 'Asset Name', col: 1 },
        { text: 'Accessories', col: 2 },
        { text: 'Asset ID', col: 3 },
        { text: 'QTY', col: 4 },
        { text: 'Value (AED)', col: 5 },
    ];

    for (const label of labels) {
        drawWrappedTextInCell(
            page,
            fontBold,
            label.text,
            colX[label.col],
            colX[label.col + 1],
            headerTop,
            headerHeight,
            { size: 7 },
        );
    }
}

function drawAssetRow(page, font, row, rowTop, rowHeight) {
    const { colX } = LAYOUT.table;

    drawRectBorder(page, colX[0], rowTop, colX[colX.length - 1] - colX[0], rowHeight);

    for (let i = 1; i <= 5; i += 1) {
        drawLine(page, colX[i], rowTop, colX[i], rowTop - rowHeight);
    }

    drawWrappedTextInCell(page, font, String(row.index + 1), colX[0], colX[1], rowTop, rowHeight);
    drawWrappedTextInCell(page, font, row.name, colX[1], colX[2], rowTop, rowHeight, { align: 'left' });
    drawAccessoryListInCell(page, font, row.accessories, colX[2], colX[3], rowTop, rowHeight);
    drawWrappedTextInCell(page, font, row.assetId, colX[3], colX[4], rowTop, rowHeight);
    drawWrappedTextInCell(page, font, String(row.quantity ?? 1), colX[4], colX[5], rowTop, rowHeight);
    drawWrappedTextInCell(page, font, formatMoney(row.totalValue), colX[5], colX[6], rowTop, rowHeight);
}

function drawTotalRow(page, fontBold, rowTop, total) {
    const { colX } = LAYOUT.table;
    const rowHeight = 18;
    const tableWidth = colX[colX.length - 1] - colX[0];

    drawRectBorder(page, colX[0], rowTop, tableWidth, rowHeight);
    drawLine(page, colX[5], rowTop, colX[5], rowTop - rowHeight);

    const totalLabel = 'Total';
    const labelWidth = fontBold.widthOfTextAtSize(totalLabel, 8);
    page.drawText(totalLabel, {
        x: colX[5] - labelWidth - 8,
        y: rowTop - rowHeight + 6,
        size: 8,
        font: fontBold,
        color: BLACK,
    });
    drawWrappedTextInCell(page, fontBold, formatMoney(total), colX[5], colX[6], rowTop, rowHeight);
}

function paginateRows(listRows, font) {
    const pages = [];
    let current = [];
    let y = LAYOUT.table.firstRowTop;

    for (let i = 0; i < listRows.length; i += 1) {
        const row = { ...listRows[i], index: i };
        const h = rowHeightForAsset(row, font);
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

        const total = listRows.reduce((sum, row) => sum + (Number(row.totalValue) || 0), 0);

        const pages = paginateRows(listRows, font);

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
                    {
                        index: 0,
                        name: 'No assets assigned',
                        assetId: '—',
                        quantity: 0,
                        totalValue: 0,
                        accessories: [],
                    },
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
