import mongoose from 'mongoose';
import AssetItem from '../models/AssetItem.js';
import { generatePdfFromHtml, pdfOutputToBuffer } from './generatePdf.js';
import { BULK_ASSET_INVENTORY_PDF_SELECTOR } from './assetHandoverPdfConstants.js';

function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

async function loadInventoryRows(assetIds) {
    const ids = [...new Set((assetIds || []).map(String).filter(Boolean))];
    const assets = await AssetItem.find({ _id: { $in: ids } })
        .select('assetId name status accessories')
        .populate('categoryId', 'name')
        .populate('typeId', 'name')
        .lean();
    const order = new Map(ids.map((v, i) => [v, i]));
    assets.sort((a, b) => (order.get(a._id.toString()) ?? 0) - (order.get(b._id.toString()) ?? 0));
    return assets.map((a) => ({
        assetId: a.assetId,
        name: a.name,
        status: a.status,
        categoryName: a.categoryId?.name || '—',
        typeName: a.typeId?.name || '—',
        accessories: (a.accessories || []).map((acc) => ({
            name: acc.name || '—',
            status: acc.status || '—'
        }))
    }));
}

function buildInventoryHtmlDoc(rows) {
    const n = rows.length;
    const rowsHtml =
        rows.length === 0
            ? `<tr><td colspan="6" style="padding:12px 8px;color:#64748b;">No assets found for this request.</td></tr>`
            : rows
                  .map((row) => {
                      const accHtml =
                          row.accessories?.length > 0
                              ? `<ul style="margin:0;padding-left:18px;">${row.accessories
                                    .map((acc) => {
                                        const showStatus =
                                            acc.status &&
                                            acc.status !== 'Attached' &&
                                            acc.status !== '—';
                                        return `<li>${escapeHtml(acc.name)}${
                                            showStatus
                                                ? ` <span style="color:#64748b">(${escapeHtml(acc.status)})</span>`
                                                : ''
                                        }</li>`;
                                    })
                                    .join('')}</ul>`
                              : '<span style="color:#94a3b8">—</span>';
                      return `<tr style="border-bottom:1px solid #e2e8f0;">
          <td style="padding:8px;font-family:monospace;font-size:12px;">${escapeHtml(row.assetId)}</td>
          <td style="padding:8px;">${escapeHtml(row.name)}</td>
          <td style="padding:8px;color:#475569;">${escapeHtml(row.categoryName)}</td>
          <td style="padding:8px;color:#475569;">${escapeHtml(row.typeName)}</td>
          <td style="padding:8px;">${escapeHtml(row.status)}</td>
          <td style="padding:8px;">${accHtml}</td>
        </tr>`;
                  })
                  .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Asset inventory</title>
</head>
<body style="margin:0;background:#fff;">
<div id="bulk-asset-inventory-pdf" data-inventory-ready="true" style="min-height:120px;padding:24px;font-family:Segoe UI,Tahoma,sans-serif;color:#1e293b;box-sizing:border-box;">
  <h1 style="font-size:20px;margin:0 0 4px 0;">Asset inventory</h1>
  <p style="font-size:13px;color:#64748b;margin:0 0 24px 0;">${n} item${n === 1 ? '' : 's'} — VeRP</p>
  <table style="width:100%;border-collapse:collapse;font-size:13px;">
    <thead>
      <tr style="border-bottom:2px solid #cbd5e1;background:#f8fafc;">
        <th style="text-align:left;padding:8px;font-weight:600;">Asset ID</th>
        <th style="text-align:left;padding:8px;font-weight:600;">Name</th>
        <th style="text-align:left;padding:8px;font-weight:600;">Category</th>
        <th style="text-align:left;padding:8px;font-weight:600;">Type</th>
        <th style="text-align:left;padding:8px;font-weight:600;">Status</th>
        <th style="text-align:left;padding:8px;font-weight:600;">Accessories</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>
</div>
</body>
</html>`;
}

/**
 * Builds a PDF buffer for email attachments by loading AssetItem rows from the DB and rendering HTML in Puppeteer.
 * Does not call the frontend — works even when /print/asset-bulk-inventory is missing on the deployed site.
 *
 * @param {object} _req — kept for call-site compatibility (unused).
 * @param {string[]} assetIds — Mongo ObjectId strings
 */
export async function generateBulkAssetInventoryPdf(_req, assetIds) {
    const ids = [...new Set((assetIds || []).map(String).filter(Boolean))];
    if (ids.length === 0) return null;
    for (const id of ids) {
        if (!mongoose.Types.ObjectId.isValid(id)) {
            console.warn('[generateBulkAssetInventoryPdf] Invalid id skipped:', id);
            return null;
        }
    }

    try {
        const rows = await loadInventoryRows(ids);
        const html = buildInventoryHtmlDoc(rows);
        const raw = await generatePdfFromHtml(html, BULK_ASSET_INVENTORY_PDF_SELECTOR);
        const buf = pdfOutputToBuffer(raw);
        if (!buf?.length) return null;
        return buf;
    } catch (e) {
        console.error('[generateBulkAssetInventoryPdf]', e?.message || e);
        return null;
    }
}

/** Nodemailer attachment array from inventory PDF, or empty if generation fails. */
export async function buildBulkAssetInventoryPdfAttachment(req, assetIds, filenameBase = 'asset-inventory') {
    const buf = await generateBulkAssetInventoryPdf(req, assetIds);
    if (!buf?.length) return [];
    const safe = `${String(filenameBase).replace(/[^a-zA-Z0-9._-]/g, '_')}-${assetIds.length}.pdf`;
    console.log(`[bulkInventoryPdf] ${safe} (${buf.length} bytes)`);
    return [
        {
            filename: safe,
            content: buf,
            contentType: 'application/pdf',
            contentDisposition: 'attachment'
        }
    ];
}
