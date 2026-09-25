import mongoose from 'mongoose';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import AssetItem from '../../models/AssetItem.js';
import UtilityEntry from '../../models/UtilityEntry.js';
import {
    FLEET_VEHICLE_ASSET_ID_PREFIX,
    TOOLS_ASSET_ID_PREFIX,
} from '../../utils/fleetVehicleAssetId.js';

const HIDDEN_ASSET_STATUSES = new Set([
    'Draft',
    'Pending',
    'Rejected',
    'Submitted for Approval',
    'Unassigned',
    'Returned',
    'End of Life',
    'Out of Service',
    'Cancelled',
]);

function isVehicleAsset(item) {
    const plate = String(item?.plateNumber || '').trim();
    const id = String(item?.assetId || '').trim().toUpperCase();
    if (plate) return true;
    if (id.startsWith(FLEET_VEHICLE_ASSET_ID_PREFIX.toUpperCase())) return true;
    if (id.startsWith(TOOLS_ASSET_ID_PREFIX.toUpperCase())) return false;
    return Boolean(
        String(item?.vehicleBrand || '').trim() ||
            String(item?.vehicleCode || '').trim() ||
            String(item?.plateEmirate || '').trim(),
    );
}

function roundMoney(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
}

function mapDocuments(item) {
    return (item.documents || [])
        .map((doc) => {
            const url = String(doc?.attachment || '').trim();
            const name = String(doc?.type || doc?.description || '').trim();
            if (!url && !name) return null;
            return {
                name: name || 'Document',
                url,
                mimeType: '',
            };
        })
        .filter(Boolean);
}

function mapToolItem(item) {
    const typeName = item.typeId?.name || item.type || 'Tool';
    return {
        id: String(item._id),
        code: item.assetId || item.name || 'Tool',
        assetId: item.assetId || '',
        name: item.name || typeName,
        value: roundMoney(item.assetValue),
        type: typeName,
        title: item.name || typeName,
        status: item.status || 'Assigned',
        documents: mapDocuments(item),
        date: item.assignedDate || item.updatedAt || item.createdAt || null,
        href: `/HRM/Asset/details/${item._id}`,
    };
}

function mapVehicleItem(item) {
    const plate = String(item.plateNumber || '').trim();
    const typeName = item.typeId?.name || 'Vehicle';
    return {
        id: String(item._id),
        code: plate || item.assetId || item.name || 'Vehicle',
        assetId: item.assetId || '',
        name: plate || item.name || item.assetId || 'Vehicle',
        value: roundMoney(item.assetValue),
        type: typeName,
        title: [item.vehicleBrand, item.name].filter(Boolean).join(' · ') || item.assetId || '',
        number: plate,
        plateNumber: plate,
        status: item.status || 'Assigned',
        documents: mapDocuments(item),
        date: item.assignedDate || item.updatedAt || item.createdAt || null,
        href: `/HRM/Asset/Vehicle/details/${item._id}`,
    };
}

function utilityProvider(entry) {
    const values = entry?.values && typeof entry.values === 'object' ? entry.values : {};
    return String(values.provider || values.vendor || '').trim() || 'Other';
}

function utilityAccount(entry) {
    const values = entry?.values && typeof entry.values === 'object' ? entry.values : {};
    return String(values.accountNumber || values.accountNo || '').trim();
}

function utilityDetails(entry) {
    const values = entry?.values && typeof entry.values === 'object' ? entry.values : {};
    const details = [];
    for (const [key, value] of Object.entries(values)) {
        if (value == null || typeof value === 'object') continue;
        const text = String(value).trim();
        if (!text || text.length > 160) continue;
        const label = key
            .replace(/([A-Z])/g, ' $1')
            .replace(/[_-]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        details.push({
            label: label.charAt(0).toUpperCase() + label.slice(1),
            value: text,
        });
    }
    return details.slice(0, 8);
}

function mapUtilityItem(entry) {
    const provider = utilityProvider(entry);
    const account = utilityAccount(entry);
    return {
        id: String(entry._id),
        code: account || entry.type || 'Utility',
        number: account,
        type: entry.type || 'Utility',
        title: entry.type || '',
        group: provider,
        status: entry.status || 'Active',
        details: utilityDetails(entry),
        date: entry.assignedAt || entry.updatedAt || entry.createdAt || null,
        href: `/HRM/Asset/UtilityBills/details/${encodeURIComponent(String(entry._id))}`,
    };
}

/**
 * @route GET /api/Employee/dashboard/my-asset-cards
 */
export const getMyAssetDashboardCards = async (req, res) => {
    try {
        const empty = { tools: [], vehicles: [], utilities: [] };
        const employeeObjectId = req.user?.employeeObjectId || null;
        const employeeCode = String(req.user?.employeeId || '').trim();

        let emp = null;
        if (employeeObjectId && mongoose.Types.ObjectId.isValid(employeeObjectId)) {
            emp = await EmployeeBasic.findById(employeeObjectId).select('_id employeeId').lean();
        }
        if (!emp && employeeCode) {
            emp = await EmployeeBasic.findOne({ employeeId: employeeCode }).select('_id employeeId').lean();
        }
        if (!emp?._id) {
            return res.status(200).json(empty);
        }

        const empMongoId = String(emp._id);
        const empId = String(emp.employeeId || employeeCode || '').trim();
        const assigneeIds = [...new Set([empMongoId, empId].filter(Boolean))];

        const [assets, utilities] = await Promise.all([
            AssetItem.find({
                assignedTo: emp._id,
                assignedToType: { $ne: 'Company' },
                status: { $nin: [...HIDDEN_ASSET_STATUSES] },
            })
                .select(
                    'assetId name assetValue status assignedDate plateNumber vehicleBrand vehicleCode plateEmirate typeId documents createdAt updatedAt',
                )
                .populate('typeId', 'name')
                .sort({ assignedDate: -1, updatedAt: -1 })
                .lean(),
            UtilityEntry.find({
                assignedToType: 'Employee',
                assignedToId: { $in: assigneeIds },
                status: { $ne: 'Inactive' },
            })
                .select('type status values assignedAt assignedToId pendingStatusChange createdAt updatedAt')
                .sort({ assignedAt: -1, updatedAt: -1 })
                .lean(),
        ]);

        const tools = [];
        const vehicles = [];
        (assets || []).forEach((item) => {
            if (isVehicleAsset(item)) vehicles.push(mapVehicleItem(item));
            else tools.push(mapToolItem(item));
        });

        return res.status(200).json({
            tools,
            vehicles,
            utilities: (utilities || [])
                .filter((entry) => !entry?.pendingStatusChange)
                .map(mapUtilityItem),
        });
    } catch (error) {
        console.error('[getMyAssetDashboardCards]', error);
        return res.status(500).json({ message: 'Failed to load dashboard asset cards' });
    }
};
