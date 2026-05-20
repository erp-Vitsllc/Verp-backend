import mongoose from 'mongoose';
import AssetItem from '../models/AssetItem.js';
import { generatePdfFromHtml, pdfOutputToBuffer } from './generatePdf.js';
import {
    BULK_ASSET_INVENTORY_PDF_SELECTOR,
    ASSET_CONTROLLER_RESPONSIBILITY_PDF_SELECTOR,
    ASSET_CONTROLLER_OUTCOME_PDF_SELECTOR,
    BULK_ASSIGNEE_DISPOSITION_PDF_SELECTOR,
    BULK_ASSIGNMENT_HANDOVER_PDF_SELECTOR,
} from './assetHandoverPdfConstants.js';

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

function inventoryRowsNestedAccessoryHtml(rows) {
    if (!rows?.length) {
        return `<tr><td colspan="5" style="padding:12px 8px;color:#64748b;">No assets in this section.</td></tr>`;
    }
    return rows
        .map((row) => {
            const accHtml =
                row.accessories?.length > 0
                    ? `<ul style="margin:4px 0 0 0;padding-left:18px;font-size:12px;">${row.accessories
                          .map((acc) => {
                              const showStatus =
                                  acc.status && acc.status !== 'Attached' && acc.status !== '—';
                              return `<li>${escapeHtml(acc.name)}${
                                  showStatus
                                      ? ` <span style="color:#64748b">(${escapeHtml(acc.status)})</span>`
                                      : ''
                              }</li>`;
                          })
                          .join('')}</ul>`
                    : `<div style="font-size:11px;color:#94a3b8;margin-top:4px;">No accessories</div>`;
            return `<tr style="border-bottom:1px solid #e2e8f0;vertical-align:top;">
          <td style="padding:10px 8px;font-family:monospace;font-size:12px;">${escapeHtml(row.assetId)}</td>
          <td style="padding:10px 8px;font-weight:600;">${escapeHtml(row.name)}</td>
          <td style="padding:10px 8px;color:#475569;">${escapeHtml(row.categoryName)}</td>
          <td style="padding:10px 8px;color:#475569;">${escapeHtml(row.typeName)}</td>
          <td style="padding:10px 8px;">${escapeHtml(row.status)}</td>
        </tr>
        <tr style="border-bottom:1px solid #f1f5f9;background:#f8fafc;">
          <td colspan="5" style="padding:6px 8px 12px 24px;font-size:12px;"><span style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;">Accessories</span>${accHtml}</td>
        </tr>`;
        })
        .join('');
}

function buildAssetControllerResponsibilityHtmlDoc(parkingInventoryRows, unassignedInventoryRows) {
    const unassignedCount = unassignedInventoryRows?.length || 0;
    const parkingCount = parkingInventoryRows?.length || 0;
    const theadCommon = `
        <tr style="border-bottom:2px solid #cbd5e1;">
          <th style="text-align:left;padding:8px;font-weight:600;">Asset ID</th>
          <th style="text-align:left;padding:8px;font-weight:600;">Name</th>
          <th style="text-align:left;padding:8px;font-weight:600;">Category</th>
          <th style="text-align:left;padding:8px;font-weight:600;">Type</th>
          <th style="text-align:left;padding:8px;font-weight:600;">Status</th>
        </tr>`;

    const tableParking = `
    <h2 style="font-size:16px;margin:28px 0 8px 0;color:#0f172a;border-bottom:2px solid #fcd34d;padding-bottom:6px;">A. Parking — On Leave</h2>
    <p style="font-size:12px;color:#64748b;margin:0 0 12px 0;">Assets parked while the assignee is on leave. Accessories are listed under each main asset.</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>${theadCommon.replace('border-bottom:2px solid #cbd5e1;', 'border-bottom:2px solid #fcd34d;background:#fffbeb;')}</thead>
      <tbody>${inventoryRowsNestedAccessoryHtml(parkingInventoryRows)}</tbody>
    </table>`;

    const tableUnassigned = `
    <h2 style="font-size:16px;margin:28px 0 8px 0;color:#0f172a;border-bottom:2px solid #a7f3d0;padding-bottom:6px;">B. Unassigned Asset (available)</h2>
    <p style="font-size:12px;color:#64748b;margin:0 0 12px 0;"></p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:8px;">
      <thead>${theadCommon.replace('border-bottom:2px solid #cbd5e1;', 'border-bottom:2px solid #a7f3d0;background:#ecfdf5;')}</thead>
      <tbody>${inventoryRowsNestedAccessoryHtml(unassignedInventoryRows)}</tbody>
    </table>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Asset Controller handover</title>
</head>
<body style="margin:0;background:#fff;">
<div id="asset-controller-handover-pdf" data-inventory-ready="true" style="min-height:120px;padding:24px;font-family:Segoe UI,Tahoma,sans-serif;color:#1e293b;box-sizing:border-box;max-width:1000px;margin:0 auto;">
  <h1 style="font-size:20px;margin:0 0 4px 0;">Asset Controller — Asset handover</h1>
  <p style="font-size:13px;color:#64748b;margin:0 0 8px 0;">VERP</p>
  <p style="font-size:12px;color:#475569;margin:0 0 16px 0;"><strong>${parkingCount}</strong> parked (on leave) · <strong>${unassignedCount}</strong> in unassigned pool</p>
  ${tableParking}
  ${tableUnassigned}
</div>
</body>
</html>`;
}

/**
 * PDF for Asset Controller flowchart handover: parking first, then unassigned pool; accessories under each asset.
 */
export async function generateAssetControllerResponsibilityPdfFromLean(unassignedLean, parkingLean) {
    const uIds = (unassignedLean || []).map((a) => a._id?.toString()).filter(Boolean);
    const pIds = (parkingLean || []).map((a) => a._id?.toString()).filter(Boolean);
    for (const id of [...uIds, ...pIds]) {
        if (!mongoose.Types.ObjectId.isValid(id)) {
            console.warn('[generateAssetControllerResponsibilityPdfFromLean] Invalid id:', id);
            return null;
        }
    }
    try {
        const uRows = uIds.length ? await loadInventoryRows(uIds) : [];
        const pRows = pIds.length ? await loadInventoryRows(pIds) : [];
        if (!uRows.length && !pRows.length) return null;
        const html = buildAssetControllerResponsibilityHtmlDoc(pRows, uRows);
        const raw = await generatePdfFromHtml(html, ASSET_CONTROLLER_RESPONSIBILITY_PDF_SELECTOR);
        const buf = pdfOutputToBuffer(raw);
        if (!buf?.length) return null;
        return buf;
    } catch (e) {
        console.error('[generateAssetControllerResponsibilityPdfFromLean]', e?.message || e);
        return null;
    }
}

export async function buildAssetControllerResponsibilityPdfAttachment(unassignedLean, parkingLean) {
    const buf = await generateAssetControllerResponsibilityPdfFromLean(unassignedLean, parkingLean);
    if (!buf?.length) return [];
    const n = (unassignedLean?.length || 0) + (parkingLean?.length || 0);
    const safe = `asset-controller-handover-${n}.pdf`;
    console.log(`[assetControllerHandoverPdf] ${safe} (${buf.length} bytes)`);
    return [{ filename: safe, content: buf, contentType: 'application/pdf', contentDisposition: 'attachment' }];
}

function buildCompanyAssetsResponsibilityHtmlDoc(companyAssetRows) {
    const n = companyAssetRows?.length || 0;
    const rowsHtml = !n
        ? `<tr><td colspan="3" style="padding:12px 8px;color:#64748b;">No company assets found.</td></tr>`
        : companyAssetRows
            .map((a) => `<tr style="border-bottom:1px solid #e2e8f0;">
          <td style="padding:8px;font-family:monospace;font-size:12px;">${escapeHtml(a.assetId)}</td>
          <td style="padding:8px;">${escapeHtml(a.name)}</td>
          <td style="padding:8px;">${escapeHtml(a.status || '—')}</td>
        </tr>`)
            .join('');
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/><title>Company assets</title></head>
<body style="margin:0;background:#fff;">
<div id="bulk-asset-inventory-pdf" data-inventory-ready="true" style="min-height:120px;padding:24px;font-family:Segoe UI,Tahoma,sans-serif;color:#1e293b;box-sizing:border-box;">
  <h1 style="font-size:20px;margin:0 0 4px 0;">Company assets</h1>
  <p style="font-size:13px;color:#64748b;margin:0 0 24px 0;">${n} item${n === 1 ? '' : 's'} — VeRP</p>
  <table style="width:100%;border-collapse:collapse;font-size:13px;">
    <thead>
      <tr style="border-bottom:2px solid #cbd5e1;background:#f8fafc;">
        <th style="text-align:left;padding:8px;font-weight:600;">Asset ID</th>
        <th style="text-align:left;padding:8px;font-weight:600;">Name</th>
        <th style="text-align:left;padding:8px;font-weight:600;">Status</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>
</div>
</body>
</html>`;
}

export async function buildCompanyAssetsResponsibilityPdfAttachment(companyAssetsLean, filenameBase = 'company-assets-responsibility') {
    const rows = (companyAssetsLean || []).map((a) => ({
        assetId: a?.assetId || '—',
        name: a?.name || '—',
        status: a?.status || '—'
    }));
    if (!rows.length) return [];
    try {
        const html = buildCompanyAssetsResponsibilityHtmlDoc(rows);
        const raw = await generatePdfFromHtml(html, BULK_ASSET_INVENTORY_PDF_SELECTOR);
        const buf = pdfOutputToBuffer(raw);
        if (!buf?.length) return [];
        const safe = `${String(filenameBase).replace(/[^a-zA-Z0-9._-]/g, '_')}-${rows.length}.pdf`;
        return [{ filename: safe, content: buf, contentType: 'application/pdf', contentDisposition: 'attachment' }];
    } catch (e) {
        console.error('[buildCompanyAssetsResponsibilityPdfAttachment]', e?.message || e);
        return [];
    }
}

function buildAssetControllerOutcomeHtmlDoc(keptRows, returnedRows) {
    const thead = `
        <tr style="border-bottom:2px solid #cbd5e1;background:#f8fafc;">
          <th style="text-align:left;padding:8px;font-weight:600;">Asset ID</th>
          <th style="text-align:left;padding:8px;font-weight:600;">Name</th>
          <th style="text-align:left;padding:8px;font-weight:600;">Category</th>
          <th style="text-align:left;padding:8px;font-weight:600;">Type</th>
          <th style="text-align:left;padding:8px;font-weight:600;">Status</th>
        </tr>`;

    const tableBlock = (rows) => `
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:4px;">
      <thead>${thead}</thead>
      <tbody>${inventoryRowsNestedAccessoryHtml(rows)}</tbody>
    </table>`;

    const nk = keptRows?.length || 0;
    const nr = returnedRows?.length || 0;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Asset controller handover result</title>
</head>
<body style="margin:0;background:#fff;">
<div id="asset-controller-outcome-pdf" data-inventory-ready="true" style="min-height:120px;padding:24px;font-family:Segoe UI,Tahoma,sans-serif;color:#1e293b;box-sizing:border-box;max-width:1000px;margin:0 auto;">
  <h1 style="font-size:20px;margin:0 0 6px 0;">Asset Controller — handover result</h1>
  <p style="font-size:12px;color:#64748b;margin:0 0 20px 0;">VeRP · ${nk} item(s) staying open or on leave · ${nr} item(s) assigned back to the previous controller</p>

  <h2 style="font-size:15px;margin:24px 0 8px 0;color:#0f172a;border-bottom:2px solid #86efac;padding-bottom:6px;">1. Accepted by the new controller (stays open or on leave)</h2>
  <p style="font-size:12px;color:#475569;margin:0 0 10px 0;">These items stay as they were. They are <strong>not</strong> moved onto the previous controller’s assignment list.</p>
  ${tableBlock(keptRows)}

  <h2 style="font-size:15px;margin:24px 0 8px 0;color:#0f172a;border-bottom:2px solid #fcd34d;padding-bottom:6px;">2. Returned to the previous controller’s list</h2>
  <p style="font-size:12px;color:#475569;margin:0 0 10px 0;">The new controller chose to hand these back. They are now <strong>assigned</strong> to the previous Asset Controller to manage.</p>
  ${tableBlock(returnedRows)}

  <div style="margin-top:28px;padding:14px;background:#f1f5f9;border-radius:10px;border:1px solid #e2e8f0;">
    <p style="margin:0;font-size:12px;color:#334155;line-height:1.55;"><strong>Summary:</strong> Section 1 lists items the new controller kept under their watch as open or on leave. Section 2 lists items that were put back on the previous controller’s assignment list before the role change was completed.</p>
  </div>
</div>
</body>
</html>`;
}

/**
 * PDF for Asset Controller <strong>approval</strong> email: two sections — kept open/on leave vs assigned back to previous controller.
 */
export async function generateAssetControllerHandoverOutcomePdfFromIds(keptIds, reassignedIds) {
    const k = [...new Set((keptIds || []).map(String).filter(Boolean))].filter((id) => mongoose.Types.ObjectId.isValid(id));
    const r = [...new Set((reassignedIds || []).map(String).filter(Boolean))].filter((id) => mongoose.Types.ObjectId.isValid(id));
    try {
        const kRows = k.length ? await loadInventoryRows(k) : [];
        const rRows = r.length ? await loadInventoryRows(r) : [];
        const html = buildAssetControllerOutcomeHtmlDoc(kRows, rRows);
        const raw = await generatePdfFromHtml(html, ASSET_CONTROLLER_OUTCOME_PDF_SELECTOR);
        const buf = pdfOutputToBuffer(raw);
        if (!buf?.length) return null;
        return buf;
    } catch (e) {
        console.error('[generateAssetControllerHandoverOutcomePdfFromIds]', e?.message || e);
        return null;
    }
}

export async function buildAssetControllerHandoverOutcomePdfAttachment(keptIds, reassignedIds) {
    const buf = await generateAssetControllerHandoverOutcomePdfFromIds(keptIds, reassignedIds);
    if (!buf?.length) return [];
    const n = (keptIds?.length || 0) + (reassignedIds?.length || 0);
    const safe = `asset-controller-handover-outcome-${n}.pdf`;
    console.log(`[assetControllerOutcomePdf] ${safe} (${buf.length} bytes)`);
    return [{ filename: safe, content: buf, contentType: 'application/pdf', contentDisposition: 'attachment' }];
}

function buildAssigneeBulkDispositionHtmlDoc(processedRows, notProcessedRows) {
    const thead = `
        <tr style="border-bottom:2px solid #cbd5e1;background:#f8fafc;">
          <th style="text-align:left;padding:8px;font-weight:600;">Asset ID</th>
          <th style="text-align:left;padding:8px;font-weight:600;">Name</th>
          <th style="text-align:left;padding:8px;font-weight:600;">Category</th>
          <th style="text-align:left;padding:8px;font-weight:600;">Type</th>
          <th style="text-align:left;padding:8px;font-weight:600;">Status</th>
        </tr>`;
    const tableBlock = (rows) => `
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:4px;">
      <thead>${thead}</thead>
      <tbody>${inventoryRowsNestedAccessoryHtml(rows)}</tbody>
    </table>`;
    const np = processedRows?.length || 0;
    const nr = notProcessedRows?.length || 0;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Bulk asset request result</title>
</head>
<body style="margin:0;background:#fff;">
<div id="bulk-assignee-disposition-pdf" data-inventory-ready="true" style="min-height:120px;padding:24px;font-family:Segoe UI,Tahoma,sans-serif;color:#1e293b;box-sizing:border-box;max-width:1000px;margin:0 auto;">
  <h1 style="font-size:20px;margin:0 0 6px 0;">Bulk request — Asset Controller decision</h1>
  <p style="font-size:12px;color:#64748b;margin:0 0 20px 0;">VeRP · <strong>${np}</strong> processed · <strong>${nr}</strong> not processed (remain as assigned)</p>

  <h2 style="font-size:15px;margin:24px 0 8px 0;color:#0f172a;border-bottom:2px solid #86efac;padding-bottom:6px;">1. Processed</h2>
  <p style="font-size:12px;color:#475569;margin:0 0 10px 0;">These assets were updated by the Asset Controller.</p>
  ${tableBlock(processedRows)}

  <h2 style="font-size:15px;margin:24px 0 8px 0;color:#0f172a;border-bottom:2px solid #fecaca;padding-bottom:6px;">2. Not processed</h2>
  <p style="font-size:12px;color:#475569;margin:0 0 10px 0;">These assets were not approved for change. They remain assigned to you with no pending request.</p>
  ${tableBlock(notProcessedRows)}

  <div style="margin-top:28px;padding:14px;background:#f1f5f9;border-radius:10px;border:1px solid #e2e8f0;">
    <p style="margin:0;font-size:12px;color:#334155;line-height:1.55;"><strong>Summary:</strong> Section 1 lists assets that were actioned. Section 2 lists assets that stayed on your assignment list.</p>
  </div>
</div>
</body>
</html>`;
}

/**
 * PDF for assignee email after bulk transfer/return decisions: processed vs not processed.
 */
export async function buildBulkAssigneeDispositionPdfAttachment(processedIds, notProcessedIds, filenameBase = 'bulk-assignee-outcome') {
    const p = [...new Set((processedIds || []).map(String).filter(Boolean))].filter((id) => mongoose.Types.ObjectId.isValid(id));
    const r = [...new Set((notProcessedIds || []).map(String).filter(Boolean))].filter((id) => mongoose.Types.ObjectId.isValid(id));
    try {
        const pRows = p.length ? await loadInventoryRows(p) : [];
        const rRows = r.length ? await loadInventoryRows(r) : [];
        const html = buildAssigneeBulkDispositionHtmlDoc(pRows, rRows);
        const raw = await generatePdfFromHtml(html, BULK_ASSIGNEE_DISPOSITION_PDF_SELECTOR);
        const buf = pdfOutputToBuffer(raw);
        if (!buf?.length) return [];
        const safe = `${String(filenameBase).replace(/[^a-zA-Z0-9._-]/g, '_')}-${p.length}-${r.length}.pdf`;
        return [{ filename: safe, content: buf, contentType: 'application/pdf', contentDisposition: 'attachment' }];
    } catch (e) {
        console.error('[buildBulkAssigneeDispositionPdfAttachment]', e?.message || e);
        return [];
    }
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
    if (!buf?.length) {
        console.warn(`[bulkInventoryPdf] Empty PDF buffer for ${assetIds?.length || 0} asset(s).`);
        return [];
    }
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

/**
 * Same as buildBulkAssetInventoryPdfAttachment but throws if the PDF could not be produced.
 * Use for bulk request emails so notifications always include the asset list PDF.
 */
export async function requireBulkAssetInventoryPdfAttachment(req, assetIds, filenameBase = 'asset-inventory') {
    const att = await buildBulkAssetInventoryPdfAttachment(req, assetIds, filenameBase);
    if (!Array.isArray(att) || att.length === 0) {
        const msg = 'Asset list PDF could not be generated. Ensure asset IDs are valid and the PDF service is available.';
        // In hosted environments, Chromium/Puppeteer may be unavailable. Allow business flow to continue
        // without attachment unless strict mode is explicitly enabled.
        if (String(process.env.STRICT_PDF_ATTACHMENTS || '').toLowerCase() === 'true') {
            throw new Error(msg);
        }
        console.error(`[requireBulkAssetInventoryPdfAttachment] ${msg} Proceeding without attachment.`);
        return [];
    }
    return att;
}

/**
 * Absolute URL for signature / upload images inside server-generated handover PDFs (Puppeteer).
 * Mirrors frontend HandoverFormView getSignatureUrl behavior.
 */
export function resolveSignatureUrlForPdf(sig, frontendBase) {
    const fe = String(frontendBase || process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
    const apiRoot = String(
        process.env.BACKEND_PUBLIC_URL || process.env.SERVER_URL || process.env.API_URL || 'http://localhost:5000',
    )
        .replace(/\/api\/?$/i, '')
        .replace(/\/+$/, '');
    let url = null;
    if (!sig) return '';
    if (typeof sig === 'string') url = sig;
    else if (typeof sig === 'object') {
        url =
            sig.url ||
            sig.data ||
            sig.path ||
            (typeof sig.signature === 'string' ? sig.signature : sig.signature?.url || sig.signature?.data) ||
            null;
    }
    if (!url || typeof url !== 'string' || url === 'undefined' || url === 'null') return '';
    if (url.startsWith('data:')) return url;
    if (/^https?:\/\//i.test(url)) return url;
    let normalizedPath = url.startsWith('/') ? url : `/${url}`;
    const isUpload = normalizedPath.includes('uploads') || normalizedPath.includes('signatures');
    if (isUpload || !normalizedPath.startsWith('/assets')) {
        return `${apiRoot}${normalizedPath}`.replace(/([^:]\/)\/+/g, '$1');
    }
    return `${fe}${normalizedPath}`;
}

/** @typedef {{ assigneeName?: string, employeeCode?: string, department?: string, hodName?: string, assignerName?: string, handoverDate?: Date, assignerSignatureUrl?: string, showAssigneeSignature?: boolean, assigneeSignatureUrl?: string, assigneeAcknowledgeName?: string }} BulkAssignmentHandoverMeta */

function formatAccessoriesPlainSummary(accList) {
    if (!accList?.length) return '—';
    return accList
        .map((acc) => {
            const nm = escapeHtml(acc?.name || '—');
            const id =
                acc?.accessoryId != null && String(acc.accessoryId).trim() !== ''
                    ? escapeHtml(String(acc.accessoryId).trim())
                    : '';
            return id ? `${nm} (${id})` : nm;
        })
        .join('; ');
}

async function loadBulkAssignmentHandoverRows(assetIds) {
    const ids = [...new Set((assetIds || []).map(String).filter(Boolean))];
    const assets = await AssetItem.find({ _id: { $in: ids } })
        .select('assetId name assetValue assignedDate accessories quantity')
        .lean();
    const order = new Map(ids.map((v, i) => [v, i]));
    assets.sort((a, b) => (order.get(a._id.toString()) ?? 0) - (order.get(b._id.toString()) ?? 0));
    return assets.map((a) => ({
        assetId: a.assetId || '—',
        name: a.name || '—',
        assetValue: Number(a.assetValue) || 0,
        assignedDate: a.assignedDate || null,
        quantity: Number(a.quantity) >= 1 && Number.isFinite(Number(a.quantity)) ? Math.floor(Number(a.quantity)) : 1,
        accessories: Array.isArray(a.accessories) ? a.accessories : [],
    }));
}

function formatMoneyAed(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return '—';
    return `AED ${x.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function formatDateEnGb(d) {
    if (!d) return '—';
    try {
        const t = new Date(d);
        if (Number.isNaN(t.getTime())) return '—';
        return t.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
    } catch {
        return '—';
    }
}

function filterAttachedAccessoriesForHandover(accList) {
    if (!Array.isArray(accList)) return [];
    return accList.filter((acc) => {
        const st = String(acc?.status || '').trim();
        return !st || st === 'Attached';
    });
}

function buildBulkAssignmentHandoverHtmlDoc(rows, ctx) {
    const TD_LABEL =
        "border:1px solid #9ca3af;padding:8px;width:25%;background:rgba(249,250,251,0.65);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#4b5563;font-family:Georgia,'Times New Roman',serif;";
    const TD_VAL =
        "border:1px solid #9ca3af;padding:8px;width:25%;font-size:11px;font-weight:700;color:#111827;font-family:Georgia,'Times New Roman',serif;";
    const TH =
        "border:1px solid #9ca3af;padding:8px;background:rgba(249,250,251,0.9);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#374151;font-family:Georgia,'Times New Roman',serif;";

    const assigneeName = escapeHtml(ctx.assigneeName || '—');
    const employeeCode = escapeHtml(ctx.employeeCode || '—');
    const department = escapeHtml(ctx.department || '—');
    const hodName = escapeHtml(ctx.hodName || '—');
    const assignerName = escapeHtml(ctx.assignerName || '—');
    const handoverDate = ctx.handoverDate instanceof Date && !Number.isNaN(ctx.handoverDate.getTime())
        ? ctx.handoverDate
        : new Date();
    const handoverDateDisplay = formatDateEnGb(handoverDate);
    const generatedWhen = escapeHtml(
        handoverDate.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }),
    );

    const rowList = rows || [];
    if (rowList.length === 0) {
        return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>Asset Handover Form</title></head>
<body style="margin:0;background:#fff;"><div id="bulk-assignment-handover-pdf" data-bulk-handover-ready="true" style="padding:24px;font-family:Georgia,serif;"><p>No assets in this assignment.</p></div></body></html>`;
    }

    let sumQty = 0;
    let sumValue = 0;
    for (const r of rowList) {
        sumQty += r.quantity || 1;
        sumValue += Number(r.assetValue) || 0;
    }

    const frontendBase = String(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
    const handoverBgUrl = `${frontendBase}/assets/loan_bg_clean.jpg`;
    const handoverBgCssUrl = JSON.stringify(handoverBgUrl);

    const assignerSigUrl = ctx.assignerSignatureUrl ? escapeHtml(String(ctx.assignerSignatureUrl)) : '';
    const assignerSigBlock = assignerSigUrl
        ? `<div style="margin-top:8px;"><img src="${assignerSigUrl}" alt="" style="max-height:52px;max-width:240px;object-fit:contain;object-position:left center;" /></div>`
        : `<div style="margin-top:10px;min-height:48px;border-bottom:1px solid #374151;max-width:280px;"></div>`;

    const showAckSig = ctx.showAssigneeSignature === true && ctx.assigneeSignatureUrl;
    const ackNameRaw = ctx.assigneeAcknowledgeName || ctx.assigneeName || '';
    const ackName = escapeHtml(ackNameRaw || '—');
    const assigneeSigUrl = showAckSig ? escapeHtml(String(ctx.assigneeSignatureUrl)) : '';
    const receivedBlock = showAckSig
        ? `<div style="margin-top:8px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
            <span style="text-transform:uppercase;font-weight:700;">${ackName}</span>
            <img src="${assigneeSigUrl}" alt="" style="max-height:52px;max-width:240px;object-fit:contain;object-position:left center;" />
          </div>`
        : `<div style="margin-top:10px;min-height:48px;border-bottom:1px solid #374151;max-width:280px;"></div>`;

    const assignmentRowsHtml = rowList
        .map((row, idx) => {
            const receivedLabel = row.assignedDate
                ? formatDateEnGb(row.assignedDate)
                : '<span style="color:#6b7280;font-size:10px;">Pending acceptance</span>';
            const accListHtml = formatAccessoriesPlainSummary(filterAttachedAccessoriesForHandover(row.accessories));
            return `<tr>
          <td style="border:1px solid #9ca3af;padding:8px;text-align:center;font-weight:600;">${idx + 1}</td>
          <td style="border:1px solid #9ca3af;padding:8px;font-family:ui-monospace,monospace;font-size:10px;font-weight:700;color:#1e40af;">${escapeHtml(row.assetId)}</td>
          <td style="border:1px solid #9ca3af;padding:8px;">${escapeHtml(row.name)}</td>
          <td style="border:1px solid #9ca3af;padding:8px;text-align:center;">${row.quantity || 1}</td>
          <td style="border:1px solid #9ca3af;padding:8px;font-size:9px;line-height:1.45;">${accListHtml}</td>
          <td style="border:1px solid #9ca3af;padding:8px;font-size:10px;">${receivedLabel}</td>
          <td style="border:1px solid #9ca3af;padding:8px;text-align:right;white-space:nowrap;font-weight:600;">${escapeHtml(formatMoneyAed(row.assetValue))}</td>
        </tr>`;
        })
        .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Asset Handover Form</title>
</head>
<body style="margin:0;background:#fff;">
<div id="bulk-assignment-handover-pdf" data-bulk-handover-ready="true" style="box-sizing:border-box;max-width:210mm;margin:0 auto;padding:25mm 20mm 30mm 20mm;font-family:Georgia,'Times New Roman',serif;color:#333;line-height:1.45;background-color:#fff;background-image:url(${handoverBgCssUrl});background-size:100% 100%;background-position:center;background-repeat:no-repeat;min-height:297mm;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
  <p style="font-size:9px;color:#9ca3af;text-align:right;margin:0 0 8px 0;">VeRP · ${generatedWhen}</p>
  <h1 style="text-align:center;font-size:22px;font-weight:600;text-decoration:underline;letter-spacing:0.12em;text-transform:uppercase;margin:0 0 22px 0;color:#111827;">Asset Handover Form</h1>

  <div style="border:1px solid #9ca3af;margin-bottom:22px;">
    <table style="width:100%;border-collapse:collapse;font-size:10px;">
      <tbody>
        <tr>
          <td style="${TD_LABEL}">Employee Name</td>
          <td style="${TD_VAL}">${assigneeName}</td>
          <td style="${TD_LABEL}">Handover By</td>
          <td style="${TD_VAL}">${assignerName}</td>
        </tr>
        <tr>
          <td style="${TD_LABEL}">Employee Code</td>
          <td style="${TD_VAL}">${employeeCode}</td>
          <td style="${TD_LABEL}">Handover Date</td>
          <td style="${TD_VAL}">${escapeHtml(handoverDateDisplay)}</td>
        </tr>
        <tr>
          <td style="${TD_LABEL}">HOD Name</td>
          <td style="${TD_VAL}">${hodName}</td>
          <td style="${TD_LABEL}">Department</td>
          <td style="${TD_VAL}">${department}</td>
        </tr>
      </tbody>
    </table>
  </div>

  <p style="font-size:13px;font-style:italic;margin:0 0 16px 0;color:#4b5563;">Please find the below assets handed over to you to carry out your assignment:</p>

  <div style="margin-bottom:24px;page-break-inside:avoid;">
    <table style="width:100%;border-collapse:collapse;border:1px solid #9ca3af;font-size:10px;">
      <thead><tr>
        <th style="${TH}width:36px;text-align:center;">SI</th>
        <th style="${TH}text-align:left;">Asset ID</th>
        <th style="${TH}text-align:left;">Asset name</th>
        <th style="${TH}width:44px;text-align:center;">Qty</th>
        <th style="${TH}text-align:left;">Accessory list</th>
        <th style="${TH}text-align:left;">Asset received date</th>
        <th style="${TH}text-align:right;">Asset value</th>
      </tr></thead>
      <tbody>
        ${assignmentRowsHtml}
        <tr style="background:rgba(243,244,246,0.95);font-weight:700;">
          <td colspan="3" style="border:1px solid #9ca3af;padding:10px;text-align:right;">Total Qty</td>
          <td style="border:1px solid #9ca3af;padding:10px;text-align:center;">${sumQty}</td>
          <td colspan="2" style="border:1px solid #9ca3af;padding:10px;text-align:right;">Total value</td>
          <td style="border:1px solid #9ca3af;padding:10px;text-align:right;">${escapeHtml(formatMoneyAed(sumValue))}</td>
        </tr>
      </tbody>
    </table>
  </div>

  <div style="margin-bottom:20px;font-size:13px;font-weight:700;color:#000;">
    <span style="display:block;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px;">Handover By</span>
    <span style="display:inline-block;min-height:22px;">${assignerName}</span>
    ${assignerSigBlock}
  </div>

  <div style="margin-bottom:16px;">
    <h3 style="font-size:13px;font-weight:700;text-decoration:underline;text-transform:uppercase;letter-spacing:0.06em;margin:0 0 10px 0;color:#111827;">Acknowledgment &amp; Declaration:</h3>
    <p style="font-size:13px;text-align:justify;color:#6b7280;line-height:1.65;margin:0;">
      I, <span style="font-weight:700;border-bottom:1px dashed #374151;padding:0 4px;">${assigneeName}</span>, acknowledge receipt of the above-mentioned asset(s) for use in the course of my assignment with the company,
      subject to company policy on care, loss, and damage of company property.
    </p>
  </div>

  <div style="margin-bottom:20px;font-size:13px;font-weight:700;color:#000;">
    <span style="display:block;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px;">Received and Acknowledge</span>
    ${receivedBlock}
  </div>

  <div style="margin-top:28px;padding-top:12px;border-top:1px solid #e5e7eb;display:flex;justify-content:space-between;font-size:9px;color:#9ca3af;font-style:italic;">
    <span>Document generated: ${generatedWhen}</span>
    <span>Handover date: ${escapeHtml(handoverDateDisplay)}</span>
  </div>
</div>
</body>
</html>`;
}

export async function generateBulkAssignmentHandoverPdf(_req, assetIds, ctx = {}) {
    const ids = [...new Set((assetIds || []).map(String).filter(Boolean))];
    if (ids.length === 0) return null;
    for (const id of ids) {
        if (!mongoose.Types.ObjectId.isValid(id)) {
            console.warn('[generateBulkAssignmentHandoverPdf] Invalid id skipped:', id);
            return null;
        }
    }
    try {
        const rows = await loadBulkAssignmentHandoverRows(ids);
        const html = buildBulkAssignmentHandoverHtmlDoc(rows, ctx);
        const raw = await generatePdfFromHtml(html, BULK_ASSIGNMENT_HANDOVER_PDF_SELECTOR);
        const buf = pdfOutputToBuffer(raw);
        if (!buf?.length) return null;
        return buf;
    } catch (e) {
        console.error('[generateBulkAssignmentHandoverPdf]', e?.message || e);
        return null;
    }
}

export async function buildBulkAssignmentHandoverPdfAttachment(req, assetIds, ctx, filenameBase = 'bulk-asset-handover') {
    const buf = await generateBulkAssignmentHandoverPdf(req, assetIds, ctx);
    if (!buf?.length) {
        console.warn(`[bulkAssignmentHandoverPdf] Empty PDF buffer for ${assetIds?.length || 0} asset(s).`);
        return [];
    }
    const safe = `${String(filenameBase).replace(/[^a-zA-Z0-9._-]/g, '_')}-${assetIds.length}.pdf`;
    console.log(`[bulkAssignmentHandoverPdf] ${safe} (${buf.length} bytes)`);
    return [{ filename: safe, content: buf, contentType: 'application/pdf', contentDisposition: 'attachment' }];
}

export async function requireBulkAssignmentHandoverPdfAttachment(req, assetIds, ctx, filenameBase = 'bulk-asset-handover') {
    const att = await buildBulkAssignmentHandoverPdfAttachment(req, assetIds, ctx, filenameBase);
    if (!Array.isArray(att) || att.length === 0) {
        const msg =
            'Bulk assignment handover PDF could not be generated. Ensure asset IDs are valid and the PDF service is available.';
        if (String(process.env.STRICT_PDF_ATTACHMENTS || '').toLowerCase() === 'true') {
            throw new Error(msg);
        }
        console.error(`[requireBulkAssignmentHandoverPdfAttachment] ${msg} Proceeding without attachment.`);
        return [];
    }
    return att;
}
