import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveFrontendBaseUrl } from './resolveFrontendBaseUrl.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HANDOVER_BG_PATH = path.join(__dirname, '../../VERP_frontend/public/assets/loan_bg_clean.jpg');

export const EMPLOYEE_ASSET_LIST_PDF_SELECTOR = '#employee-asset-list-pdf[data-asset-list-ready="true"]';

const BORDER = '1px solid #9ca3af';
const TD_LABEL =
    `border:${BORDER};padding:8px;width:25%;background:rgba(249,250,251,0.65);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#000;font-family:Georgia,'Times New Roman',serif;`;
const TD_VAL =
    `border:${BORDER};padding:8px;width:25%;font-size:11px;font-weight:700;color:#000;text-align:center;font-family:Georgia,'Times New Roman',serif;`;
const TH =
    `border:${BORDER};padding:8px;background:rgba(249,250,251,0.9);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#000;text-align:center;font-family:Georgia,'Times New Roman',serif;`;
const TD =
    `border:${BORDER};padding:8px;font-size:10px;color:#000;font-family:Georgia,'Times New Roman',serif;`;
const SUB_TH =
    `border:${BORDER};padding:5px 6px;font-weight:700;font-size:9px;color:#000;background:rgba(249,250,251,0.85);text-align:center;font-family:Georgia,'Times New Roman',serif;`;
const SUB_TD =
    `border:${BORDER};padding:5px 6px;font-size:9px;color:#000;font-family:Georgia,'Times New Roman',serif;`;

function esc(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function getHandoverBackgroundCssUrl() {
    if (fs.existsSync(HANDOVER_BG_PATH)) {
        const b64 = fs.readFileSync(HANDOVER_BG_PATH).toString('base64');
        return JSON.stringify(`data:image/jpeg;base64,${b64}`);
    }
    const frontendBase = String(resolveFrontendBaseUrl()).replace(/\/+$/, '');
    return JSON.stringify(`${frontendBase}/assets/loan_bg_clean.jpg`);
}

export function formatAssetListDate(value) {
    if (!value) return '—';
    try {
        const t = new Date(value);
        if (Number.isNaN(t.getTime())) return '—';
        return t.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
    } catch {
        return '—';
    }
}

export function formatAssetListMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0.00';
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function filterAttachedAccessories(accList) {
    if (!Array.isArray(accList)) return [];
    return accList.filter((acc) => {
        const st = String(acc?.status || '').trim();
        return !st || st === 'Attached';
    });
}

/**
 * Build grouped asset rows — one row per asset with nested accessories.
 */
export function buildEmployeeAssetListRows(assets) {
    const rows = [];
    for (const asset of assets || []) {
        const assignedDate =
            asset.status === 'Returned'
                ? asset.updatedAt
                : asset.assignedDate || asset.updatedAt;

        const accessories = filterAttachedAccessories(asset.accessories).map((acc) => ({
            name: acc.name || '—',
            price: Number(acc.amount) || 0,
        }));

        const assetValue = Number(asset.assetValue) || 0;
        const accessoryTotal = accessories.reduce((sum, acc) => sum + (Number(acc.price) || 0), 0);
        const quantity = Number(asset.quantity);
        const qty = Number.isFinite(quantity) && quantity > 0 ? quantity : 1;

        rows.push({
            name: asset.name || '—',
            assetId: asset.assetId || '—',
            quantity: qty,
            value: assetValue,
            totalValue: assetValue + accessoryTotal,
            assignedDate,
            status: asset.status || 'Assigned',
            accessories,
        });
    }
    return rows;
}

function buildStatusCellHtml(status, accessories) {
    let accessoriesBlock;

    if (!accessories?.length) {
        accessoriesBlock = `<div style="margin-top:8px;padding:6px;text-align:center;font-weight:700;font-size:9px;color:#000;border:${BORDER};background:rgba(255,255,255,0.35);">NO ACC</div>`;
    } else {
        const accRows = accessories
            .map(
                (acc, idx) => `<tr>
                    <td style="${SUB_TD};text-align:left;font-weight:600;">${idx + 1}. ${esc(acc.name)}</td>
                    <td style="${SUB_TD};text-align:center;font-weight:700;">${esc(formatAssetListMoney(acc.price))}</td>
                </tr>`,
            )
            .join('');

        accessoriesBlock = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-top:8px;">
            <tr>
                <td style="${SUB_TH};text-align:center;" colspan="2">Accessories</td>
            </tr>
            <tr>
                <td style="${SUB_TH};text-align:left;">Name</td>
                <td style="${SUB_TH};width:72px;">Price (AED)</td>
            </tr>
            ${accRows}
        </table>`;
    }

    return `<td style="${TD};vertical-align:top;text-align:center;">
        <div style="font-weight:700;font-size:10px;margin-bottom:2px;color:#000;">${esc(status)}</div>
        ${accessoriesBlock}
    </td>`;
}

function buildAssetTableRows(rows) {
    if (!rows.length) {
        return `<tr><td colspan="5" style="${TD};text-align:center;color:#000;">No assets assigned.</td></tr>`;
    }

    const body = rows
        .map(
            (row, index) => `<tr>
        <td style="${TD};text-align:center;font-weight:700;width:36px;">${index + 1}</td>
        <td style="${TD};font-weight:600;">${esc(row.name)}</td>
        <td style="${TD};text-align:center;font-weight:700;">${esc(formatAssetListMoney(row.value))}</td>
        <td style="${TD};text-align:center;">${esc(formatAssetListDate(row.assignedDate))}</td>
        ${buildStatusCellHtml(row.status, row.accessories)}
      </tr>`,
        )
        .join('');

    const total = rows.reduce((sum, row) => {
        const accTotal = (row.accessories || []).reduce((s, acc) => s + (Number(acc.price) || 0), 0);
        return sum + (Number(row.value) || 0) + accTotal;
    }, 0);

    return `${body}
      <tr>
        <td style="${TD};font-weight:700;text-align:right;" colspan="2">Total</td>
        <td style="${TD};text-align:center;font-weight:700;">${esc(formatAssetListMoney(total))}</td>
        <td style="${TD};text-align:center;" colspan="2"></td>
      </tr>`;
}

/**
 * Employee asset list PDF — same background as handover form, black text, dynamic data.
 */
export function buildEmployeeAssetListPdfHtml({
    employeeName,
    employeeCode,
    hodName,
    reportDate,
    listRows,
}) {
    const bgCssUrl = getHandoverBackgroundCssUrl();
    const tableBody = buildAssetTableRows(listRows);
    const generatedWhen = esc(
        new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Asset List — ${esc(employeeName)}</title>
<style>
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body style="margin:0;background:#fff;">
<div id="employee-asset-list-pdf" data-asset-list-ready="true" style="box-sizing:border-box;max-width:210mm;margin:0 auto;padding:25mm 20mm 30mm 20mm;font-family:Georgia,'Times New Roman',serif;color:#000;line-height:1.45;background-color:#fff;background-image:url(${bgCssUrl});background-size:100% 100%;background-position:center;background-repeat:no-repeat;min-height:297mm;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
  <p style="font-size:9px;color:#000;text-align:right;margin:0 0 8px 0;opacity:0.55;">VeRP · ${generatedWhen}</p>
  <h1 style="text-align:center;font-size:22px;font-weight:600;text-decoration:underline;letter-spacing:0.12em;text-transform:uppercase;margin:0 0 22px 0;color:#000;">Asset List</h1>

  <div style="border:${BORDER};margin-bottom:22px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
      <tbody>
        <tr>
          <td style="${TD_LABEL}">Date</td>
          <td style="${TD_VAL}">${esc(reportDate)}</td>
          <td style="${TD_LABEL}">Employee Name</td>
          <td style="${TD_VAL}">${esc(employeeName)}</td>
        </tr>
        <tr>
          <td style="${TD_LABEL}">Employee Code</td>
          <td style="${TD_VAL}">${esc(employeeCode || '—')}</td>
          <td style="${TD_LABEL}">HOD Name</td>
          <td style="${TD_VAL}">${esc(hodName || '—')}</td>
        </tr>
      </tbody>
    </table>
  </div>

  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:${BORDER};">
    <thead>
      <tr>
        <th style="${TH};width:36px;">#</th>
        <th style="${TH};text-align:left;">Asset Name</th>
        <th style="${TH};width:100px;">Value (AED)</th>
        <th style="${TH};width:100px;">Assigned Date</th>
        <th style="${TH};width:180px;">Status</th>
      </tr>
    </thead>
    <tbody>
      ${tableBody}
    </tbody>
  </table>

  <div style="margin-top:28px;padding-top:12px;border-top:${BORDER};display:flex;justify-content:space-between;font-size:9px;color:#000;opacity:0.55;font-style:italic;">
    <span>Document generated: ${generatedWhen}</span>
    <span>List date: ${esc(reportDate)}</span>
  </div>
</div>
</body>
</html>`;
}
