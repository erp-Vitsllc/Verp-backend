import { uploadDocumentToS3 } from './s3Upload.js';
import { generateLoanAcknowledgmentPdfBuffer } from './generateLoanAcknowledgmentPdf.js';
import { appendApprovalAttachmentHistory } from './approvalAttachmentHistory.js';

/**
 * Stores management-approved acknowledgment PDF on the loan record (S3 + approvalAttachments).
 */
export async function persistLoanApprovalAttachments(
    loanDoc,
    { forceRegenerate = false, trigger = forceRegenerate ? 'schedule-edit' : 'management-approval' } = {},
) {
    if (!loanDoc) return loanDoc;

    const hasAck = Array.isArray(loanDoc.approvalAttachments)
        && loanDoc.approvalAttachments.some((a) => a.source === 'acknowledgment');

    if (!forceRegenerate && hasAck) {
        return loanDoc;
    }

    const entries = forceRegenerate && Array.isArray(loanDoc.approvalAttachments)
        ? loanDoc.approvalAttachments.filter((e) => e.source === 'supporting')
        : (loanDoc.approvalAttachments || []).filter((e) => e.source === 'supporting');

    try {
        const buffer = await generateLoanAcknowledgmentPdfBuffer(loanDoc);
        if (buffer?.length > 500) {
            const typeSlug = loanDoc.type === 'Advance' ? 'Advance' : 'Loan';
            const filename = `${typeSlug}_Acknowledgment_${loanDoc.loanId || loanDoc._id}.pdf`;
            const uploaded = await uploadDocumentToS3(buffer.toString('base64'), 'loans', filename);
            const withoutOldAck = entries.filter((e) => e.source !== 'acknowledgment');
            withoutOldAck.push({
                label: `${typeSlug} Acknowledgment`,
                name: filename,
                url: uploaded.url || '',
                publicId: uploaded.publicId || '',
                mimeType: 'application/pdf',
                source: 'acknowledgment',
                addedAt: new Date(),
            });
            loanDoc.approvalAttachments = withoutOldAck;
            appendApprovalAttachmentHistory(loanDoc, [withoutOldAck.find((e) => e.source === 'acknowledgment')].filter(Boolean), {
                trigger,
            });
            await loanDoc.save();
        }
    } catch (err) {
        console.error('[persistLoanApprovalAttachments] Failed:', err?.message || err);
    }

    return loanDoc;
}

export async function getLoanAcknowledgmentPdfBuffer(loanDoc) {
    if (!loanDoc) return null;
    return generateLoanAcknowledgmentPdfBuffer(loanDoc);
}
