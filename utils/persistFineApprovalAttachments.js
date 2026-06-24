import { uploadDocumentToS3 } from './s3Upload.js';
import { generateFineApprovedReportPdfBuffer } from './generateFineApprovedReportPdfBuffer.js';
import { isAssetLossFineReportApplicable } from './sendAssetLossFineReportEmail.js';
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

    const hasSupporting = entries.some(e => e.source === 'supporting');
    if (!hasSupporting && att && (att.url || att.publicId || att.data || att.name)) {
        entries.push({
            label: 'Supporting Document',
            name: att.name || `Supporting-${fineDoc.fineId || fineDoc._id}`,
            url: att.url || '',
            publicId: att.publicId || '',
            mimeType: att.mimeType || 'application/pdf',
            source: 'supporting',
            addedAt,
        });
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
            const filename = isAssetLoss
                ? `AssetLossFineReport-${fineDoc.fineId || fineDoc._id}.pdf`
                : `FineApproval-${fineDoc.fineId || fineDoc._id}.pdf`;
            const uploaded = await uploadDocumentToS3(base64, 'fines', filename);
            entries.push({
                label: isAssetLoss ? 'Asset Loss Fine Report' : 'Fine Approval Form',
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
        fineDoc.approvalAttachments = entries;
        appendApprovalAttachmentHistory(fineDoc, entries, { trigger, scheduleChange });
        await fineDoc.save();
    }

    return fineDoc;
}
