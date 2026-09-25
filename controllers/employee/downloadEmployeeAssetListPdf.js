import mongoose from 'mongoose';
import AssetItem from '../../models/AssetItem.js';
import { getCompleteEmployee } from '../../services/employeeService.js';
import { generateEmployeeAssetListFromTemplatePdf, resolveAssetListPrintMeta } from '../../utils/generateEmployeeAssetListFromTemplatePdf.js';
import { FLEET_VEHICLE_ASSET_ID_PREFIX, TOOLS_ASSET_ID_PREFIX } from '../../utils/fleetVehicleAssetId.js';

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
    'name assetId assetValue quantity status assignedDate updatedAt accessories acceptanceStatus assignedTo assignedCompany assignedToType typeId categoryId';

export async function loadAssetsByIds(assetIds) {
    const validIds = [...new Set((assetIds || []).map((id) => String(id).trim()))].filter((id) =>
        mongoose.Types.ObjectId.isValid(id),
    );
    if (!validIds.length) return [];

    return AssetItem.find({ _id: { $in: validIds } })
        .select(ASSET_LIST_SELECT)
        .populate({
            path: 'assignedTo',
            select: 'firstName lastName employeeId primaryReportee',
            populate: { path: 'primaryReportee', select: 'firstName lastName employeeId' },
        })
        .populate('assignedCompany', 'name companyId nickName companyShortName')
        .populate('typeId', 'name')
        .populate('categoryId', 'name')
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

        const pdfBuffer = await generateEmployeeAssetListFromTemplatePdf({
            employee,
            assets,
            ...resolveAssetListPrintMeta(req.user),
        });

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

function isToolsAsset(asset) {
    const assetNo = String(asset?.assetId || '').trim().toUpperCase();
    if (assetNo.startsWith(FLEET_VEHICLE_ASSET_ID_PREFIX.toUpperCase())) return false;
    if (assetNo.startsWith(TOOLS_ASSET_ID_PREFIX.toUpperCase())) return true;
    const typeName = String(asset?.typeId?.name || asset?.type || '').toLowerCase();
    if (
        typeName.includes('vehicle') ||
        typeName.includes('car') ||
        typeName.includes('van') ||
        typeName.includes('fleet')
    ) {
        return false;
    }
    const plate = String(asset?.plateNumber || '').trim();
    return !plate;
}

function belongsToEmployee(asset, employeeObjectId) {
    const assigned = asset?.assignedTo;
    const assignedId = assigned && typeof assigned === 'object' ? assigned._id : assigned;
    return Boolean(assignedId) && String(assignedId) === String(employeeObjectId);
}

/**
 * Same Tools Asset PDF as Salary → Tools Asset → Your Assets.
 * Assigned-to and the file name use the logged-in employee.
 */
export const downloadMyAssetListPdf = async (req, res) => {
    try {
        const id = req.user?.employeeObjectId || req.user?.employeeId;
        if (!id) {
            return res.status(400).json({ message: 'No linked employee record found' });
        }

        const employee = await getCompleteEmployee(id);
        if (!employee?._id) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        const requestedIds = parseAssetIdsFromQuery(req.query);
        let assets = requestedIds.length
            ? await loadAssetsByIds(requestedIds)
            : await loadAssetsByIds((await loadEmployeeHeldAssets(employee._id)).map((item) => item._id));

        assets = (assets || []).filter(
            (asset) => belongsToEmployee(asset, employee._id) && isToolsAsset(asset),
        );

        if (!assets.length) {
            return res.status(404).json({ message: 'There are no tools in this list to download.' });
        }

        const namedAssets = assets.map((asset) => {
            const assigned = asset.assignedTo;
            const hasName =
                assigned &&
                typeof assigned === 'object' &&
                (`${assigned.firstName || ''} ${assigned.lastName || ''}`.trim() || assigned.employeeId);
            if (hasName) return asset;
            return { ...asset, assignedTo: employee };
        });

        const pdfBuffer = await generateEmployeeAssetListFromTemplatePdf({
            employee,
            assets: namedAssets,
            ...resolveAssetListPrintMeta({
                ...req.user,
                name:
                    `${employee.firstName || ''} ${employee.lastName || ''}`.trim() ||
                    req.user?.name ||
                    employee.employeeId,
            }),
        });

        if (!pdfBuffer || pdfBuffer.length < 500) {
            return res.status(500).json({ message: 'Failed to generate asset list PDF' });
        }

        const safeId = String(employee.employeeId || employee._id).replace(/[^\w.-]+/g, '_');
        const fileLabel = `AssetList-${safeId}`;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${fileLabel}.pdf"`);
        res.setHeader('Content-Length', pdfBuffer.length);
        res.send(pdfBuffer);
    } catch (error) {
        console.error('[downloadMyAssetListPdf]', error);
        res.status(500).json({ message: 'Failed to generate asset list PDF', error: error.message });
    }
};
