import {
    buildBulkAssignmentHandoverPdfAttachment,
    resolveSignatureUrlForPdf,
} from './generateBulkAssetInventoryPdf.js';

function frontendBaseUrl() {
    return (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/'/g, '');
}

/**
 * Same PDF as bulk asset assignment emails (handover form listing assets).
 */
export async function buildAssignmentHandoverEmailAttachments(
    req,
    assetIds,
    {
        assigneeName = '—',
        employeeCode = '—',
        department = '—',
        hodName = '—',
        assigner = null,
        assignerName = '—',
        handoverDate = new Date(),
        showAssigneeSignature = false,
        assigneeSignatureUrl,
        assigneeAcknowledgeName,
        filenameBase = 'asset-handover',
        strict = false,
    } = {},
) {
    const ids = [...new Set((assetIds || []).map(String).filter(Boolean))];
    if (!ids.length) return [];

    const fe = frontendBaseUrl();
    const assignerSig =
        assigner?.signature && resolveSignatureUrlForPdf(assigner.signature, fe)
            ? resolveSignatureUrlForPdf(assigner.signature, fe)
            : undefined;

    const ctx = {
        assigneeName,
        employeeCode,
        department,
        hodName,
        assignerName:
            assignerName ||
            (assigner
                ? `${assigner.firstName || ''} ${assigner.lastName || ''}`.trim()
                : '—'),
        handoverDate,
        assignerSignatureUrl: assignerSig,
        showAssigneeSignature,
        ...(assigneeSignatureUrl ? { assigneeSignatureUrl } : {}),
        ...(assigneeAcknowledgeName ? { assigneeAcknowledgeName } : {}),
    };

    try {
        const att = await buildBulkAssignmentHandoverPdfAttachment(req, ids, ctx, filenameBase);
        if (att?.length) return att;
    } catch (e) {
        if (strict) throw e;
        console.error('[buildAssignmentHandoverEmailAttachments]', e?.message || e);
    }
    return [];
}

export function hodDisplayFromEmployee(employee) {
    const hod = employee?.primaryReportee;
    if (!hod || typeof hod !== 'object') return '—';
    return (
        `${hod.firstName || ''} ${hod.lastName || ''}`.trim() ||
        hod.employeeId ||
        '—'
    );
}
