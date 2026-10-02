import Loan from '../../models/Loan.js';
import { downloadS3ObjectBytes } from '../../utils/s3Upload.js';
import { generateLoanAcknowledgmentPdfBuffer } from '../../utils/generateLoanAcknowledgmentPdf.js';

function storedAcknowledgmentKey(loan) {
    const list = Array.isArray(loan?.approvalAttachments) ? loan.approvalAttachments : [];
    const matches = list.filter((item) => item?.source === 'acknowledgment' && (item.publicId || item.url));
    const stored = matches[matches.length - 1];
    return stored?.publicId || stored?.url || '';
}

function sendPdf(res, bytes, filename) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', bytes.length);
    return res.send(bytes);
}

/**
 * Serves the management-approved loan/advance acknowledgment PDF.
 * Uses the copy already stored at approval. Chromium rebuilds it only when that file is missing.
 */
export const downloadLoanAcknowledgmentPdf = async (req, res) => {
    try {
        let { id } = req.params;
        const cleanId = id && id.includes('-') ? id.split('-').pop() : id;

        const loan = await Loan.findById(cleanId).lean();
        if (!loan) {
            return res.status(404).json({ message: 'Loan request not found' });
        }

        const isApproved = ['Approved', 'Paid'].includes(loan.approvalStatus || loan.status);
        if (!isApproved) {
            return res.status(400).json({ message: 'Acknowledgment PDF is available only for approved requests.' });
        }

        const typeSlug = loan.type === 'Advance' ? 'Advance' : 'Loan';
        const filename = `${typeSlug}_Acknowledgment_${loan.loanId || loan._id}.pdf`;

        const storedKey = storedAcknowledgmentKey(loan);
        if (storedKey) {
            const storedBytes = await downloadS3ObjectBytes(storedKey);
            if (storedBytes?.length > 500) {
                return sendPdf(res, storedBytes, filename);
            }
        }

        const generated = await generateLoanAcknowledgmentPdfBuffer(loan);
        if (generated?.length > 500) {
            return sendPdf(res, generated, filename);
        }

        return res.status(500).json({ message: 'Failed to generate acknowledgment PDF' });
    } catch (error) {
        console.error('Error generating loan acknowledgment PDF:', error);
        return res.status(500).json({
            message: 'Failed to generate acknowledgment PDF',
            error: error.message,
        });
    }
};
