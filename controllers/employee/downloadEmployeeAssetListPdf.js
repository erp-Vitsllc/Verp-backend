import mongoose from 'mongoose';
import AssetItem from '../../models/AssetItem.js';
import { getCompleteEmployee } from '../../services/employeeService.js';
import { generateEmployeeAssetListFromTemplatePdf } from '../../utils/generateEmployeeAssetListFromTemplatePdf.js';

const HELD_STATUSES = ['Assigned', 'Pending', 'On Leave', 'Out of Service', 'Returned', 'Service'];

async function loadEmployeeHeldAssets(employeeObjectId) {
    return AssetItem.find({
        $or: [
            {
                assignedTo: employeeObjectId,
                acceptanceStatus: { $in: ['Accepted', 'Pending'] },
                status: { $in: HELD_STATUSES },
            },
            { assignedBy: employeeObjectId, status: 'Returned' },
        ],
    })
        .select('name assetId assetValue quantity status assignedDate updatedAt accessories acceptanceStatus')
        .sort({ assignedDate: -1, updatedAt: -1 })
        .lean();
}

const ASSET_LIST_SELECT =
    'name assetId assetValue quantity status assignedDate updatedAt accessories acceptanceStatus';

export async function loadAssetsByIds(assetIds) {
    const validIds = [...new Set((assetIds || []).map((id) => String(id).trim()))].filter((id) =>
        mongoose.Types.ObjectId.isValid(id),
    );
    if (!validIds.length) return [];

    return AssetItem.find({ _id: { $in: validIds } })
        .select(ASSET_LIST_SELECT)
        .sort({ assignedDate: -1, updatedAt: -1 })
        .lean();
}

export function parseAssetIdsFromQuery(query) {
    const raw = query?.assetIds;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.flatMap((v) => String(v).split(','));
    return String(raw)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * Download employee asset list PDF (Salary tab → Assets → Your Assets).
 * Uses the shared ASSET LIST template PDF and fills dynamic employee asset data.
 */
export const downloadEmployeeAssetListPdf = async (req, res) => {
    try {
        const { id } = req.params;

        if (!id || String(id).trim() === '') {
            return res.status(400).json({ message: 'Employee ID is required' });
        }

        const employee = await getCompleteEmployee(id);
        if (!employee) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        const employeeObjectId = employee._id;
        if (!employeeObjectId || !mongoose.Types.ObjectId.isValid(String(employeeObjectId))) {
            return res.status(400).json({ message: 'Invalid employee record' });
        }

        const requestedAssetIds = parseAssetIdsFromQuery(req.query);
        let assets;
        if (requestedAssetIds.length > 0) {
            assets = await loadAssetsByIds(requestedAssetIds);
            if (!assets.length) {
                return res.status(404).json({ message: 'No matching assets found for this list' });
            }
        } else {
            assets = await loadEmployeeHeldAssets(employeeObjectId);
        }

        const pdfBuffer = await generateEmployeeAssetListFromTemplatePdf({ employee, assets });

        if (!pdfBuffer || pdfBuffer.length < 500) {
            return res.status(500).json({ message: 'Failed to generate asset list PDF' });
        }

        const safeId = String(employee.employeeId || employee._id).replace(/[^\w.-]+/g, '_');
        const scopeSuffix = String(req.query?.scope || '')
            .trim()
            .replace(/[^\w.-]+/g, '');
        const fileLabel = scopeSuffix ? `AssetList-${safeId}-${scopeSuffix}` : `AssetList-${safeId}`;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${fileLabel}.pdf"`);
        res.setHeader('Content-Length', pdfBuffer.length);
        res.send(pdfBuffer);
    } catch (error) {
        console.error('[downloadEmployeeAssetListPdf]', error);
        res.status(500).json({ message: 'Failed to generate asset list PDF', error: error.message });
    }
};
