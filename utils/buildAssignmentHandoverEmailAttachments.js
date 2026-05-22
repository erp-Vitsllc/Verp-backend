import {
    buildBulkAssignmentHandoverPdfAttachment,
    resolveSignatureUrlForPdf,
} from './generateBulkAssetInventoryPdf.js';

function frontendBaseUrl() {
    return (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/'/g, '');
}

function employeeDisplayName(emp) {
    if (!emp) return '—';
    const t = `${emp.firstName || ''} ${emp.lastName || ''}`.trim();
    return t || emp.employeeId || '—';
}

/** Pending request / transfer: assigner name + signature only (no assignee acknowledgment block). */
export function buildPendingRequestHandoverCtx({
    assigner = null,
    assignerName,
    assigneeName = '—',
    employeeCode = '—',
    department = '—',
    hodName = '—',
    handoverDate = new Date(),
} = {}) {
    const fe = frontendBaseUrl();
    const assignerSig = assigner?.signature
        ? resolveSignatureUrlForPdf(assigner.signature, fe)
        : undefined;
    return {
        assigneeName,
        employeeCode,
        department,
        hodName,
        assignerName: assignerName || employeeDisplayName(assigner),
        handoverDate,
        assignerSignatureUrl: assignerSig || undefined,
        showAssigneeSignature: false,
    };
}

/** Accepted or AC direct-assign: assigner + assignee name and signature on the handover form. */
export function buildFullySignedHandoverCtx({
    assigner = null,
    assignerName,
    assignee = null,
    assigneeName,
    employeeCode = '—',
    department = '—',
    hodName = '—',
    handoverDate = new Date(),
} = {}) {
    const fe = frontendBaseUrl();
    const ackName = assigneeName || employeeDisplayName(assignee);
    const assigneeSig = assignee?.signature
        ? resolveSignatureUrlForPdf(assignee.signature, fe)
        : undefined;
    return {
        ...buildPendingRequestHandoverCtx({
            assigner,
            assignerName,
            assigneeName: ackName,
            employeeCode,
            department,
            hodName,
            handoverDate,
        }),
        assigneeAcknowledgeName: ackName,
        assigneeSignatureUrl: assigneeSig || undefined,
        showAssigneeSignature: !!(assigneeSig && ackName && ackName !== '—'),
    };
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

/** Handover PDF with assigner + assignee signatures (after acceptance / direct assign). */
export async function buildAcceptedAssetHandoverAttachments(
    req,
    assetMongoId,
    filenameBase = 'asset-handover-accepted',
) {
    const AssetItem = (await import('../models/AssetItem.js')).default;
    const asset = await AssetItem.findById(assetMongoId)
        .populate({
            path: 'assignedTo',
            select: 'firstName lastName employeeId department signature',
            populate: [{ path: 'primaryReportee', select: 'firstName lastName employeeId' }],
        })
        .populate('assignedBy', 'firstName lastName signature')
        .populate('assignedCompany', 'name companyId')
        .lean();
    if (!asset) return [];

    let assigneeName = '—';
    let employeeCode = '—';
    let department = '—';
    let assignee = null;

    if (String(asset.assignedToType || '').toLowerCase() === 'company' && asset.assignedCompany) {
        const comp =
            typeof asset.assignedCompany === 'object'
                ? asset.assignedCompany
                : null;
        assigneeName = comp?.name || 'Company';
        employeeCode = comp?.companyId || '—';
        department = '—';
        if (asset.acceptedBy) {
            const EmployeeBasic = (await import('../models/EmployeeBasic.js')).default;
            assignee = await EmployeeBasic.findById(asset.acceptedBy)
                .select('firstName lastName signature')
                .lean()
                .catch(() => null);
        }
    } else if (asset.assignedTo) {
        assignee = asset.assignedTo;
        assigneeName = employeeDisplayName(assignee);
        employeeCode = assignee?.employeeId || '—';
        department = (assignee?.department && String(assignee.department).trim()) || '—';
    }

    const ctx = buildFullySignedHandoverCtx({
        assigner: asset.assignedBy,
        assignee,
        assigneeName,
        employeeCode,
        department,
        hodName: hodDisplayFromEmployee(assignee),
    });

    return buildAssignmentHandoverEmailAttachments(req, [String(assetMongoId)], {
        ...ctx,
        filenameBase,
    });
}
