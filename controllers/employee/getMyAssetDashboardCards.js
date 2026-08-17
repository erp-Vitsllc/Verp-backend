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
    'Rejected',
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

function mapToolItem(item) {
    return {
        id: String(item._id),
        code: item.assetId || item.name || 'Tool',
        type: 'Tool',
        title: item.name || item.typeId?.name || '',
        status: item.status || 'Assigned',
        date: item.assignedDate || item.updatedAt || item.createdAt || null,
        href: `/HRM/Asset/details/${item._id}`,
    };
}

function mapVehicleItem(item) {
    const plate = String(item.plateNumber || '').trim();
    return {
        id: String(item._id),
        code: plate || item.assetId || item.name || 'Vehicle',
        type: 'Vehicle',
        title: [item.vehicleBrand, item.name].filter(Boolean).join(' · ') || item.assetId || '',
        status: item.status || 'Assigned',
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

function mapUtilityItem(entry) {
    const provider = utilityProvider(entry);
    const account = utilityAccount(entry);
    return {
        id: String(entry._id),
        code: account || entry.type || 'Utility',
        type: entry.type || 'Utility',
        title: entry.type || '',
        group: provider,
        status: entry.status || 'Active',
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
                    'assetId name status assignedDate plateNumber vehicleBrand vehicleCode plateEmirate typeId createdAt updatedAt',
                )
                .populate('typeId', 'name')
                .sort({ assignedDate: -1, updatedAt: -1 })
                .lean(),
            UtilityEntry.find({
                assignedToType: 'Employee',
                assignedToId: { $in: assigneeIds },
                status: { $ne: 'Inactive' },
            })
                .select('type status values assignedAt assignedToId createdAt updatedAt')
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
            utilities: (utilities || []).map(mapUtilityItem),
        });
    } catch (error) {
        console.error('[getMyAssetDashboardCards]', error);
        return res.status(500).json({ message: 'Failed to load dashboard asset cards' });
    }
};
