import Loan from '../../models/Loan.js';
import { generateLoanAcknowledgmentPdfBuffer } from '../../utils/generateLoanAcknowledgmentPdf.js';

/**
 * Serves the management-approved loan/advance acknowledgment PDF.
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

        const generated = await generateLoanAcknowledgmentPdfBuffer(loan);
        if (generated?.length > 500) {
            const typeSlug = loan.type === 'Advance' ? 'Advance' : 'Loan';
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader(
                'Content-Disposition',
                `inline; filename="${typeSlug}_Acknowledgment_${loan.loanId || loan._id}.pdf"`,
            );
            return res.send(generated);
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
