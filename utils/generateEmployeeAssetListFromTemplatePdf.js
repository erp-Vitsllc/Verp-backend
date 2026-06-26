import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import {
    buildEmployeeAssetListRows,
} from './buildEmployeeAssetListPdfHtml.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BG_IMAGE_PATH = path.join(__dirname, '../assets/templates/asset-list-page-bg.jpg');

const PAGE_WIDTH = 595.92;
const PAGE_HEIGHT = 934.56;
const BLACK = rgb(0, 0, 0);
const LINE = rgb(0, 0, 0);

/** Measured from asset-list-template.pdf — 7 columns: Serial No | Assigned to | Asset Name | Accessories | Asset ID | QTY | Value */
const LAYOUT = {
    table: {
        x: 56,
        width: 483,
        headerTop: 810,
        headerHeight: 22,
        firstRowTop: 788,
        defaultRowHeight: 22,
        bottomLimit: 155,
        colX: [56, 88, 168, 253, 348, 418, 453, 539],
    },
};

function employeeDisplayName(employee) {
    if (!employee) return '—';
    const name = `${employee.firstName || ''} ${employee.lastName || ''}`.trim();
    return name || employee.employeeId || '—';
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
    const assignedLines = countWrappedLines(font, row.assignedTo, 8, colX[1], colX[2]);
    const nameLines = countWrappedLines(font, row.name, 8, colX[2], colX[3]);
    const accLines = countAccessoryListLines(font, row.accessories, colX[3], colX[4]);
    const assetIdLines = countWrappedLines(font, row.assetId, 8, colX[4], colX[5]);
    const qtyLines = countWrappedLines(font, String(row.quantity ?? 1), 8, colX[5], colX[6]);
    const valueLines = countWrappedLines(font, formatMoney(row.totalValue), 8, colX[6], colX[7]);

    return Math.max(
        defaultRowHeight,
        cellHeightForLines(slLines, 8, defaultRowHeight),
        cellHeightForLines(assignedLines, 8, defaultRowHeight),
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

function drawTableHeaderAt(page, fontBold, headerTop) {
    const { x, width, headerHeight, colX } = LAYOUT.table;
    const headerBottom = headerTop - headerHeight;

    drawRectBorder(page, x, headerTop, width, headerHeight);

    for (let i = 1; i <= 6; i += 1) {
        drawLine(page, colX[i], headerTop, colX[i], headerBottom);
    }

    const labels = [
        { text: 'Serial No', col: 0 },
        { text: 'Assigned to', col: 1 },
        { text: 'Asset Name', col: 2 },
        { text: 'Accessories', col: 3 },
        { text: 'Asset ID', col: 4 },
        { text: 'QTY', col: 5 },
        { text: 'Value (AED)', col: 6 },
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

    return { top: headerTop, bottom: headerBottom, height: headerHeight, firstRowTop: headerBottom };
}

function drawAssetRow(page, font, row, rowTop, rowHeight) {
    const { colX } = LAYOUT.table;

    drawRectBorder(page, colX[0], rowTop, colX[colX.length - 1] - colX[0], rowHeight);

    for (let i = 1; i <= 6; i += 1) {
        drawLine(page, colX[i], rowTop, colX[i], rowTop - rowHeight);
    }

    drawWrappedTextInCell(page, font, String(row.index + 1), colX[0], colX[1], rowTop, rowHeight);
    drawWrappedTextInCell(page, font, row.assignedTo || '—', colX[1], colX[2], rowTop, rowHeight, { align: 'left' });
    drawWrappedTextInCell(page, font, row.name, colX[2], colX[3], rowTop, rowHeight, { align: 'left' });
    drawAccessoryListInCell(page, font, row.accessories, colX[3], colX[4], rowTop, rowHeight);
    drawWrappedTextInCell(page, font, row.assetId, colX[4], colX[5], rowTop, rowHeight);
    drawWrappedTextInCell(page, font, String(row.quantity ?? 1), colX[5], colX[6], rowTop, rowHeight);
    drawWrappedTextInCell(page, font, formatMoney(row.totalValue), colX[6], colX[7], rowTop, rowHeight);
}

function drawTotalRow(page, fontBold, rowTop, total) {
    const { colX } = LAYOUT.table;
    const rowHeight = 18;
    const tableWidth = colX[colX.length - 1] - colX[0];

    drawRectBorder(page, colX[0], rowTop, tableWidth, rowHeight);
    drawLine(page, colX[6], rowTop, colX[6], rowTop - rowHeight);

    const totalLabel = 'Total';
    const labelWidth = fontBold.widthOfTextAtSize(totalLabel, 8);
    page.drawText(totalLabel, {
        x: colX[6] - labelWidth - 8,
        y: rowTop - rowHeight + 6,
        size: 8,
        font: fontBold,
        color: BLACK,
    });
    drawWrappedTextInCell(page, fontBold, formatMoney(total), colX[6], colX[7], rowTop, rowHeight);
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

function companyDisplayName(company) {
    if (!company) return 'Company';
    if (typeof company === 'object') {
        return company.nickName || company.companyShortName || company.name || company.companyId || 'Company';
    }
    return String(company);
}

function resolveAssetAssigneeName(asset) {
    if (asset?.assignedCompany) {
        return companyDisplayName(asset.assignedCompany);
    }
    if (asset?.assignedTo && typeof asset.assignedTo === 'object') {
        return employeeDisplayName(asset.assignedTo);
    }
    return 'Unassigned';
}

function getOwnerSortKey(asset) {
    if (asset?.assignedCompany) {
        const comp = asset.assignedCompany;
        const compId = typeof comp === 'object' ? comp._id || comp.companyId : comp;
        return `b:${companyDisplayName(comp).toLowerCase()}:${compId}`;
    }
    if (asset?.assignedTo && typeof asset.assignedTo === 'object') {
        return `a:${employeeDisplayName(asset.assignedTo).toLowerCase()}:${asset.assignedTo._id || ''}`;
    }
    return 'z:unassigned';
}

function buildAssetListPdfRows(assets, { fallbackAssignee = null } = {}) {
    const fallbackName = fallbackAssignee ? employeeDisplayName(fallbackAssignee) : null;

    const orderedAssets = [...(assets || [])].sort((a, b) => {
        const keyCmp = getOwnerSortKey(a).localeCompare(getOwnerSortKey(b));
        if (keyCmp !== 0) return keyCmp;
        return String(a?.name || '').localeCompare(String(b?.name || ''));
    });

    return orderedAssets.map((asset, index) => {
        const baseRow = buildEmployeeAssetListRows([asset])[0];
        return {
            ...baseRow,
            assignedTo: resolveAssetAssigneeName(asset) || fallbackName || '—',
            index,
        };
    });
}

function renderAssetListPdf({ outputDoc, font, fontBold, bgImage, listRows }) {
    const total = listRows.reduce((sum, row) => sum + (Number(row.totalValue) || 0), 0);
    const pages = paginateRows(listRows, font);

    pages.forEach((pageRows, pageIndex) => {
        const page = outputDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        drawPageBackground(page, bgImage);
        drawTableHeaderAt(page, fontBold, LAYOUT.table.headerTop);

        if (pageRows.length === 0 && pageIndex === 0) {
            const rowTop = LAYOUT.table.firstRowTop;
            const rowHeight = LAYOUT.table.defaultRowHeight;
            drawAssetRow(
                page,
                font,
                {
                    index: 0,
                    assignedTo: '—',
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
            const totalTop = last
                ? last.rowTop - last.rowHeight
                : LAYOUT.table.firstRowTop - LAYOUT.table.defaultRowHeight;
            drawTotalRow(page, fontBold, totalTop, total);
        }
    });

    return outputDoc;
}

/**
 * Build ASSET LIST PDF: template background image + transparent overlay table (dynamic rows).
 */
export async function generateEmployeeAssetListFromTemplatePdf({
    employee,
    assets,
    headerOverride,
    groupByOwner = false,
    listTitle = 'Asset List',
}) {
    try {
        const outputDoc = await PDFDocument.create();
        const font = await outputDoc.embedFont(StandardFonts.Helvetica);
        const fontBold = await outputDoc.embedFont(StandardFonts.HelveticaBold);
        const bgImage = await embedBackground(outputDoc);

        const fallbackAssignee =
            headerOverride?.employeeName && headerOverride.employeeName !== listTitle
                ? { firstName: headerOverride.employeeName }
                : employee;

        const listRows = buildAssetListPdfRows(assets, { fallbackAssignee });

        renderAssetListPdf({ outputDoc, font, fontBold, bgImage, listRows });

        const pdfBytes = await outputDoc.save();
        return Buffer.from(pdfBytes);
    } catch (err) {
        console.error('[generateEmployeeAssetListFromTemplatePdf]', err?.message || err);
        return null;
    }
}
