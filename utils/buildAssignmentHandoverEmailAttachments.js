import {
    buildBulkAssignmentHandoverPdfAttachment,
    resolveSignatureUrlForPdf,
} from './generateBulkAssetInventoryPdf.js';
import { getSignedFileUrl } from './s3Upload.js';
import { resolveFrontendBaseUrl, emailFrontendUrl } from './resolveFrontendBaseUrl.js';

function frontendBaseUrl() {
    return emailFrontendUrl();
}

function employeeDisplayName(emp) {
    if (!emp) return '—';
    const t = `${emp.firstName || ''} ${emp.lastName || ''}`.trim();
    return t || emp.employeeId || '—';
}

/** Puppeteer must load a signed URL (or data URL); raw S3 keys fail silently in PDFs. */
export async function resolveHandoverSignatureUrl(sig, frontendBase) {
    const raw = resolveSignatureUrlForPdf(sig, frontendBase);
    if (!raw || typeof raw !== 'string') return undefined;
    if (raw.startsWith('data:')) return raw;
    if (/X-Amz-|Signature=|AWSAccessKeyId=|x-amz-/i.test(raw)) return raw;
    try {
        const signed = await getSignedFileUrl(raw);
        return signed || raw;
    } catch (e) {
        console.warn('[resolveHandoverSignatureUrl]', e?.message || e);
        return raw;
    }
}

export async function finalizeHandoverPdfCtx(ctx, { assigner = null, assignee = null } = {}) {
    return applySignedUrlsToHandoverCtx(ctx, { assigner, assignee });
}

async function applySignedUrlsToHandoverCtx(ctx, { assigner = null, assignee = null } = {}) {
    const fe = frontendBaseUrl();
    const next = { ...ctx };
    if (assigner?.signature) {
        const url = await resolveHandoverSignatureUrl(assigner.signature, fe);
        if (url) next.assignerSignatureUrl = url;
    }
    if (next.showAssigneeSignature && assignee?.signature) {
        const url = await resolveHandoverSignatureUrl(assignee.signature, fe);
        if (url) next.assigneeSignatureUrl = url;
    }
    return next;
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

/** Pending creation / approval request: handover form with requester signature only. */
export async function buildCreationRequestHandoverAttachments(
    req,
    assetMongoIds,
    { assigner = null, assignerName = '—', filenameBase = 'asset-creation-handover' } = {},
) {
    const ids = [...new Set((assetMongoIds || []).map(String).filter(Boolean))];
    if (!ids.length) return [];
    const ctx = buildPendingRequestHandoverCtx({ assigner, assignerName });
    return buildAssignmentHandoverEmailAttachments(req, ids, {
        ...ctx,
        assigner,
        filenameBase,
    });
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
        assignee = null,
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

    let ctx = {
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
        showAssigneeSignature,
        ...(assigneeSignatureUrl ? { assigneeSignatureUrl } : {}),
        ...(assigneeAcknowledgeName ? { assigneeAcknowledgeName } : {}),
    };

    ctx = await applySignedUrlsToHandoverCtx(ctx, { assigner, assignee });

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
        assigner: asset.assignedBy,
        assignee,
        filenameBase,
    });
}

/**
 * Signed Asset Handover Form PDF for one or more assets (email attachment).
 * Use instead of inventory tables or processed/not-processed decision PDFs.
 */
export async function buildBulkActionHandoverEmailAttachments(
    req,
    assetMongoIds,
    { assigner = null, assignee = null, filenameBase = 'asset-handover' } = {},
) {
    const ids = [...new Set((assetMongoIds || []).map(String).filter(Boolean))];
    if (!ids.length) return [];

    const EmployeeBasic = (await import('../models/EmployeeBasic.js')).default;

    let assignerDoc = assigner;
    if (assigner && (assigner._id || assigner) && !assigner.signature) {
        assignerDoc = await EmployeeBasic.findById(assigner._id || assigner)
            .select('firstName lastName employeeId signature department')
            .lean()
            .catch(() => assigner);
    }

    let assigneeDoc = assignee;
    if (assignee && (assignee._id || assignee) && !assignee.signature) {
        assigneeDoc = await EmployeeBasic.findById(assignee._id || assignee)
            .select('firstName lastName employeeId department signature primaryReportee')
            .populate('primaryReportee', 'firstName lastName employeeId')
            .lean()
            .catch(() => assignee);
    }

    const assigneeName = employeeDisplayName(assigneeDoc);
    const ctx = buildFullySignedHandoverCtx({
        assigner: assignerDoc,
        assignee: assigneeDoc,
        assigneeName,
        employeeCode: assigneeDoc?.employeeId || '—',
        department: (assigneeDoc?.department && String(assigneeDoc.department).trim()) || '—',
        hodName: hodDisplayFromEmployee(assigneeDoc),
    });

    return buildAssignmentHandoverEmailAttachments(req, ids, {
        ...ctx,
        assigner: assignerDoc,
        assignee: assigneeDoc,
        filenameBase,
    });
}

/** After AC approves Leave / similar: handover form with assigner + assignee signatures for assignee email. */
export async function buildApprovedActionHandoverAttachments(req, assetDoc, filenameBase = 'asset-action-approved-handover') {
    if (!assetDoc?._id) return [];
    const AssetItem = (await import('../models/AssetItem.js')).default;
    const EmployeeBasic = (await import('../models/EmployeeBasic.js')).default;

    let asset = assetDoc;
    if (!asset.assignedBy?.signature && asset.assignedBy) {
        asset = await AssetItem.findById(asset._id)
            .populate('assignedBy', 'firstName lastName employeeId signature department')
            .populate({
                path: 'assignedTo',
                select: 'firstName lastName employeeId department signature primaryReportee',
                populate: [{ path: 'primaryReportee', select: 'firstName lastName employeeId' }],
            })
            .lean();
    }
    if (!asset) return [];

    let assignee = asset.assignedTo;
    if (assignee && !assignee.signature) {
        assignee = await EmployeeBasic.findById(assignee._id || assignee)
            .select('firstName lastName employeeId department signature primaryReportee')
            .populate('primaryReportee', 'firstName lastName employeeId')
            .lean()
            .catch(() => assignee);
    }

    const assigneeName = employeeDisplayName(assignee);
    const ctx = buildFullySignedHandoverCtx({
        assigner: asset.assignedBy,
        assignee,
        assigneeName,
        employeeCode: assignee?.employeeId || '—',
        department: (assignee?.department && String(assignee.department).trim()) || '—',
        hodName: hodDisplayFromEmployee(assignee),
    });

    return buildAssignmentHandoverEmailAttachments(req, [String(asset._id)], {
        ...ctx,
        assigner: asset.assignedBy,
        assignee,
        filenameBase,
    });
}
