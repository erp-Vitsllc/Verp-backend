import AssetItem from '../models/AssetItem.js';
import { generatePdfFromHtml, pdfOutputToBuffer } from './generatePdf.js';
import { ASSET_HANDOVER_EMAIL_PDF_SELECTOR } from './assetHandoverPdfConstants.js';

function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatName(p) {
    if (!p || typeof p !== 'object') return '—';
    const t = `${p.firstName || ''} ${p.lastName || ''}`.trim();
    return t || '—';
}

async function loadAssetForHandoverPdf(assetMongoId) {
    const item = await AssetItem.findById(assetMongoId)
        .populate('assignedCompany', 'name companyId')
        .populate({
            path: 'assignedTo',
            select: 'firstName lastName employeeId',
            populate: [{ path: 'primaryReportee', select: 'firstName lastName employeeId' }]
        })
        .populate('assignedBy', 'firstName lastName employeeId')
        .populate('acceptedBy', 'firstName lastName employeeId')
        .populate('categoryId', 'name')
        .populate('typeId', 'name')
        .lean();

    if (!item) return null;

    if (item.acceptedBy && !(item.acceptedBy.firstName || item.acceptedBy.lastName)) {
        const EmployeeBasic = (await import('../models/EmployeeBasic.js')).default;
        const ab = await EmployeeBasic.findById(item.acceptedBy._id || item.acceptedBy)
            .select('firstName lastName employeeId')
            .lean();
        if (ab) item.acceptedBy = ab;
    }
    return item;
}

function buildHandoverEmailHtml(asset) {
    const category = asset.categoryId?.name || '—';
    const typeName = asset.typeId?.name || '—';
    const assignedBy = formatName(asset.assignedBy);
    const acceptedBy = formatName(asset.acceptedBy);
    const isCompany = String(asset.assignedToType || '').toLowerCase() === 'company' && asset.assignedCompany;
    const assigneeDisplay = isCompany
        ? escapeHtml(asset.assignedCompany?.name || 'Company')
        : escapeHtml(formatName(asset.assignedTo));
    const when = new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Asset handover — ${escapeHtml(asset.assetId)}</title>
</head>
<body style="margin:0;background:#fff;">
<div id="asset-handover-email-pdf" data-handover-ready="true" style="padding:28px;font-family:Segoe UI,Tahoma,sans-serif;color:#0f172a;box-sizing:border-box;max-width:800px;">
  <h1 style="font-size:20px;margin:0 0 6px 0;">Asset handover (summary)</h1>
  <p style="font-size:12px;color:#64748b;margin:0 0 22px 0;">Generated for email — ${escapeHtml(when)} — VeRP</p>
  <table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid #e2e8f0;">
    <tbody>
      <tr><td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;background:#f8fafc;width:32%;font-weight:600;">Asset ID</td><td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;">${escapeHtml(asset.assetId)}</td></tr>
      <tr><td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;background:#f8fafc;font-weight:600;">Asset name</td><td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;">${escapeHtml(asset.name)}</td></tr>
      <tr><td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;background:#f8fafc;font-weight:600;">Category</td><td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;">${escapeHtml(category)}</td></tr>
      <tr><td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;background:#f8fafc;font-weight:600;">Type</td><td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;">${escapeHtml(typeName)}</td></tr>
      <tr><td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;background:#f8fafc;font-weight:600;">Status</td><td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;">${escapeHtml(asset.status || '—')}</td></tr>
      <tr><td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;background:#f8fafc;font-weight:600;">Assigned to</td><td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;">${assigneeDisplay}${!isCompany && asset.assignedTo?.employeeId ? ` <span style="color:#64748b">(${escapeHtml(asset.assignedTo.employeeId)})</span>` : ''}</td></tr>
      <tr><td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;background:#f8fafc;font-weight:600;">Handover by</td><td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;">${escapeHtml(assignedBy)}</td></tr>
      <tr><td style="padding:10px 12px;background:#f8fafc;font-weight:600;">Received / acknowledged by</td><td style="padding:10px 12px;">${escapeHtml(acceptedBy)}</td></tr>
    </tbody>
  </table>
  <p style="font-size:11px;color:#94a3b8;margin-top:16px;">This PDF is a server-generated summary for notifications when the live handover print page is unavailable.</p>
</div>
</body>
</html>`;
}

/**
 * Handover PDF for emails without calling the frontend /print/asset-handover route (avoids 404 on stale deploys).
 */
export async function generateAssetHandoverEmailPdf(assetMongoId) {
    try {
        const asset = await loadAssetForHandoverPdf(assetMongoId);
        if (!asset) return null;
        const html = buildHandoverEmailHtml(asset);
        const raw = await generatePdfFromHtml(html, ASSET_HANDOVER_EMAIL_PDF_SELECTOR);
        return pdfOutputToBuffer(raw);
    } catch (e) {
        console.error('[generateAssetHandoverEmailPdf]', e?.message || e);
        return null;
    }
}
