import Fine from '../../models/Fine.js';
import { downloadS3ObjectBytes } from '../../utils/s3Upload.js';
import { generateFineApprovedReportPdfBuffer } from '../../utils/generateFineApprovedReportPdfBuffer.js';
import { reportPdfFileName } from '../../utils/buildAssetLossFineEmailFields.js';
import { downloadFinePdf } from './downloadFinePdf.js';

function getFineBaseId(fineId) {
    const fid = String(fineId || '').trim();
    const parts = fid.split('-');
    if (parts.length > 3) return parts.slice(0, 3).join('-');
    return fid;
}

/**
 * Resolve a fine by Mongo id, exact fineId, or group base id (VEGA-FINE-0026 → siblings -A/-B/…).
 * Prefers a sibling that already has a stored approval PDF.
 */
async function resolveFineForApprovedPdf(id) {
    const mongoose = await import('mongoose');
    const raw = String(id || '').trim();
    if (!raw) return null;

    const query = mongoose.Types.ObjectId.isValid(raw)
        ? { $or: [{ _id: raw }, { fineId: raw }] }
        : { fineId: raw };

    let fine = await Fine.findOne(query).lean();

    const baseId = getFineBaseId(fine?.fineId || raw);
    const baseIdRegex = new RegExp(`^${baseId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-[A-Z0-9]+)?$`, 'i');
    const related = await Fine.find({ fineId: baseIdRegex }).sort({ fineId: 1 }).lean();

    if (related.length > 1) {
        const withAttachment = related.find((f) =>
            (f.approvalAttachments || []).some(
                (a) =>
                    a?.publicId &&
                    (a.source === 'approved-form' || a.source === 'asset-loss-report'),
            ),
        );
        fine = withAttachment || fine || related[0];
    } else if (!fine && related.length === 1) {
        fine = related[0];
    }

    return fine;
}

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

        const fine = await resolveFineForApprovedPdf(id);
        if (!fine) {
            return res.status(404).json({ message: 'Fine not found' });
        }

        // Point PDF helpers at the concrete sibling Mongo id (not group base fineId)
        req.params.id = String(fine._id);

        const stored =
            (fine.approvalAttachments || []).find((a) => a.source === 'approved-form') ||
            (fine.approvalAttachments || []).find((a) => a.source === 'asset-loss-report');

        const storedAt = stored?.addedAt ? new Date(stored.addedAt).getTime() : 0;
        const fineUpdated = fine.updatedAt ? new Date(fine.updatedAt).getTime() : 0;
        const wantFresh = String(req.query?.fresh || '') === '1';
        const storedIsStale = !storedAt || storedAt + 1500 < fineUpdated;

        if (stored?.publicId && !wantFresh && !storedIsStale) {
            const bytes = await downloadS3ObjectBytes(stored.publicId);
            if (bytes?.length > 500) {
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader(
                    'Content-Disposition',
                    `inline; filename="${stored.name || reportPdfFileName(fine)}"`,
                );
                return res.send(bytes);
            }
        }

        const generated = await generateFineApprovedReportPdfBuffer(fine, { employeeId });
        if (generated?.length > 500) {
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader(
                'Content-Disposition',
                `inline; filename="${reportPdfFileName(fine)}"`,
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
