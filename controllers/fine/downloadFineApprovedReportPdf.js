import Fine from '../../models/Fine.js';
import { downloadS3ObjectBytes } from '../../utils/s3Upload.js';
import { generateFineApprovedReportPdfBuffer } from '../../utils/generateFineApprovedReportPdfBuffer.js';
import { downloadFinePdf } from './downloadFinePdf.js';

/**
 * Serves the management-approved fine report PDF (Asset Loss Fine Report / approval form).
 */
export const downloadFineApprovedReportPdf = async (req, res) => {
    try {
        let { id } = req.params;
        const { employeeId } = req.query;

        if (id && typeof id === 'string' && id.includes(':')) {
            id = id.split(':')[0].trim();
        }

        const mongoose = await import('mongoose');
        const query = mongoose.Types.ObjectId.isValid(id)
            ? { $or: [{ _id: id }, { fineId: id }] }
            : { fineId: id };

        const fine = await Fine.findOne(query).lean();
        if (!fine) {
            return res.status(404).json({ message: 'Fine not found' });
        }

        const stored =
            (fine.approvalAttachments || []).find((a) => a.source === 'approved-form') ||
            (fine.approvalAttachments || []).find((a) => a.source === 'asset-loss-report');

        if (stored?.publicId) {
            const bytes = await downloadS3ObjectBytes(stored.publicId);
            if (bytes?.length > 500) {
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader(
                    'Content-Disposition',
                    `inline; filename="${stored.name || `FineApproval-${fine.fineId}.pdf`}"`,
                );
                return res.send(bytes);
            }
        }

        const generated = await generateFineApprovedReportPdfBuffer(fine, { employeeId });
        if (generated?.length > 500) {
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader(
                'Content-Disposition',
                `inline; filename="AssetLossFineReport-${fine.fineId}.pdf"`,
            );
            return res.send(generated);
        }

        return downloadFinePdf(req, res);
    } catch (error) {
        console.error('Error generating approved fine report PDF:', error);
        return res.status(500).json({
            message: 'Failed to generate approved fine report PDF',
            error: error.message,
        });
    }
};
