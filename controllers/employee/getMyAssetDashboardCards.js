import mongoose from 'mongoose';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import AssetItem from '../../models/AssetItem.js';
import UtilityEntry from '../../models/UtilityEntry.js';
import VehicleFuelBill from '../../models/VehicleFuelBill.js';
import UtilityBillPayment from '../../models/UtilityBillPayment.js';
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

function currentMonthKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function mapVehicleItem(item, fuel) {
    const plate = String(item.plateNumber || '').trim();
    const typeName = item.typeId?.name || 'Vehicle';
    const limit = roundMoney(fuel?.monthlyLimit || item.fuelMonthlyLimit);
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
        currentKm: Number(item.currentKilometer) || 0,
        petrolUsage: roundMoney(fuel?.amountUsed),
        fuelLimit: limit,
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

function utilityContract(entry) {
    const values = entry?.values && typeof entry.values === 'object' ? entry.values : {};
    const raw = values.monthlyRental ?? values.contractAmount ?? values.contract;
    const amount = Number(raw);
    return Number.isFinite(amount) ? roundMoney(amount) : 0;
}

function mapUtilityItem(entry, bill) {
    const provider = utilityProvider(entry);
    const account = utilityAccount(entry);
    const contract = utilityContract(entry) || roundMoney(bill?.monthlyRental);
    return {
        id: String(entry._id),
        code: account || entry.type || 'Utility',
        number: account,
        type: entry.type || 'Utility',
        title: entry.type || '',
        group: provider,
        contractAmount: contract,
        actualAmount: bill ? roundMoney(bill.amount) : null,
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
                    'assetId name assetValue status assignedDate plateNumber vehicleBrand vehicleCode plateEmirate currentKilometer fuelMonthlyLimit typeId documents createdAt updatedAt',
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

        const vehicleAssets = (assets || []).filter(isVehicleAsset);
        const activeUtilities = (utilities || []).filter((entry) => !entry?.pendingStatusChange);
        const [fuelBills, utilityBills] = await Promise.all([
            vehicleAssets.length
                ? VehicleFuelBill.find({
                      vehicleId: { $in: vehicleAssets.map((item) => item._id) },
                      monthKey: currentMonthKey(),
                  })
                      .select('vehicleId amountUsed monthlyLimit')
                      .lean()
                : [],
            activeUtilities.length
                ? UtilityBillPayment.find({
                      entryId: { $in: activeUtilities.map((entry) => String(entry._id)) },
                  })
                      .select('entryId amount monthlyRental createdAt')
                      .sort({ createdAt: -1 })
                      .lean()
                : [],
        ]);
        const fuelByVehicle = new Map((fuelBills || []).map((bill) => [String(bill.vehicleId), bill]));
        const billByUtility = new Map();
        (utilityBills || []).forEach((bill) => {
            const key = String(bill.entryId);
            if (!billByUtility.has(key)) billByUtility.set(key, bill);
        });

        const tools = [];
        const vehicles = [];
        (assets || []).forEach((item) => {
            if (isVehicleAsset(item)) vehicles.push(mapVehicleItem(item, fuelByVehicle.get(String(item._id))));
            else tools.push(mapToolItem(item));
        });

        return res.status(200).json({
            tools,
            vehicles,
            utilities: activeUtilities.map((entry) => mapUtilityItem(entry, billByUtility.get(String(entry._id)))),
        });
    } catch (error) {
        console.error('[getMyAssetDashboardCards]', error);
        return res.status(500).json({ message: 'Failed to load dashboard asset cards' });
    }
};
