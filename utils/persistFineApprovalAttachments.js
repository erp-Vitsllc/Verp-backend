import { uploadDocumentToS3, ensureAttachmentPersistedToS3, s3ObjectExists } from './s3Upload.js';
import { generateFineApprovedReportPdfBuffer } from './generateFineApprovedReportPdfBuffer.js';
import { isAssetLossFineReportApplicable } from './sendAssetLossFineReportEmail.js';
import { reportPdfFileName, reportPdfLabel } from './buildAssetLossFineEmailFields.js';
import { appendApprovalAttachmentHistory } from './approvalAttachmentHistory.js';

/**
 * Stores approval-email attachments on the fine record when management approves.
 * Appends each generation to approvalAttachmentHistory for workflow timeline.
 */
export async function persistFineApprovalAttachments(
    fineDoc,
    { req, forceRegenerate = false, trigger = forceRegenerate ? 'schedule-edit' : 'management-approval', scheduleChange = null } = {},
) {
    if (!fineDoc) return fineDoc;
    if (!forceRegenerate && Array.isArray(fineDoc.approvalAttachments) && fineDoc.approvalAttachments.length > 0) {
        return fineDoc;
    }

    const entries = forceRegenerate && Array.isArray(fineDoc.approvalAttachments)
        ? fineDoc.approvalAttachments.filter(e => e.source === 'supporting')
        : [];
    const addedAt = new Date();
    const att = fineDoc.attachment;

    const supportingCandidates = [
        att,
        ...(Array.isArray(fineDoc.attachments) ? fineDoc.attachments : []),
    ].filter(Boolean);

    for (const item of supportingCandidates) {
        if (!(item.url || item.publicId || item.data || item.name || item.base64)) continue;
        const alreadyStored = entries.some(
            (e) =>
                e.source === 'supporting' &&
                ((item.publicId && e.publicId === item.publicId) ||
                    (item.name && e.name === item.name) ||
                    (item.url && e.url === item.url)),
        );
        if (alreadyStored) continue;
        try {
            const persisted = await ensureAttachmentPersistedToS3(item, {
                folder: `fines/${fineDoc.fineId || fineDoc._id}`,
                fileName: item.name || `Supporting-${fineDoc.fineId || fineDoc._id}.pdf`,
                resourceType: 'raw',
            });
            if (persisted?.publicId) {
                entries.push({
                    label: item.name || 'Supporting Document',
                    name: persisted.name,
                    url: persisted.url || '',
                    publicId: persisted.publicId,
                    mimeType: persisted.mimeType || item.mimeType || 'application/pdf',
                    source: 'supporting',
                    addedAt,
                });
            }
        } catch (err) {
            console.error('[persistFineApprovalAttachments] Supporting document upload failed:', err?.message || err);
        }
    }

    let pdfBase64 = req?.body?.finePdf;
    if (!pdfBase64) {
        try {
            const buffer = await generateFineApprovedReportPdfBuffer(fineDoc);
            if (buffer?.length > 500) {
                pdfBase64 = buffer.toString('base64');
            }
        } catch (err) {
            console.error('[persistFineApprovalAttachments] Server PDF generation failed:', err?.message || err);
        }
    }

    if (pdfBase64) {
        try {
            let base64 = pdfBase64;
            if (typeof base64 === 'string' && base64.includes(',')) {
                base64 = base64.split(',')[1];
            }
            const isAssetLoss = isAssetLossFineReportApplicable(fineDoc);
            const filename = reportPdfFileName(fineDoc);
            const uploaded = await uploadDocumentToS3(base64, 'fines', filename);
            entries.push({
                label: reportPdfLabel(fineDoc),
                name: filename,
                url: uploaded.url || '',
                publicId: uploaded.publicId || '',
                mimeType: 'application/pdf',
                source: isAssetLoss ? 'asset-loss-report' : 'approved-form',
                addedAt,
            });
        } catch (err) {
            console.error('[persistFineApprovalAttachments] Failed to store approval PDF:', err?.message || err);
        }
    }

    if (entries.length > 0) {
        const verified = [];
        for (const entry of entries) {
            if (entry.publicId && (await s3ObjectExists(entry.publicId))) {
                verified.push(entry);
                continue;
            }
            if (entry.data || entry.base64) {
                try {
                    const persisted = await ensureAttachmentPersistedToS3(entry, {
                        folder: 'fines',
                        fileName: entry.name || 'approval-document.pdf',
                        resourceType: 'raw',
                    });
                    if (persisted?.publicId) {
                        verified.push({ ...entry, ...persisted });
                    }
                } catch (err) {
                    console.error('[persistFineApprovalAttachments] Entry persist failed:', err?.message || err);
                }
            }
        }

        if (verified.length > 0) {
            fineDoc.approvalAttachments = verified;
            appendApprovalAttachmentHistory(fineDoc, verified, { trigger, scheduleChange });
            await fineDoc.save();
        }
    }

    return fineDoc;
}
