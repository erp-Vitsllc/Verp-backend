import AssetItem from '../../models/AssetItem.js';
import { findErpVehicleForLocatorLink, createLocatorErpVehicle } from '../../services/locatorVehicleListService.js';

export const postLocatorFixAssignment = async (req, res) => {
    try {
        const { vehicleId, employeeId, deviceId, deviceName } = req.body || {};

        let asset = null;
        if (vehicleId && !String(vehicleId).startsWith('locator-')) {
            asset = await AssetItem.findById(vehicleId);
        }
        if (!asset) {
            asset = await findErpVehicleForLocatorLink({ deviceId, deviceName });
        }

        if (!asset) {
            asset = await createLocatorErpVehicle({
                deviceId,
                deviceName,
                plateEmirate: 'Dubai',
                plateNumber: '',
            });
        }

        if (!employeeId) {
            return res.status(400).json({
                success: false,
                message: 'Employee is required',
            });
        }

        asset.assignedTo = employeeId;
        asset.assignedToType = 'Employee';
        asset.status = 'Assigned';
        if (deviceId != null) asset.locatorDeviceId = Number(deviceId);
        await asset.save();

        const updated = await AssetItem.findById(asset._id)
            .populate('assignedTo', 'firstName lastName employeeId')
            .select('assetId plateEmirate plateNumber status assignedTo locatorDeviceId')
            .lean();

        return res.status(200).json({
            success: true,
            data: updated,
            message: 'Vehicle assigned to matched employee. Locator link saved.',
        });
    } catch (error) {
        console.error('[LocatorFixAssignment] Failed:', error?.message || error);

        return res.status(500).json({
            success: false,
            message: error?.message || 'Failed to fix locator assignment',
        });
    }
};
