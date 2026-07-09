import AssetItem from '../../models/AssetItem.js';
import { getAssetItemDetail } from '../assetItemController.js';
import {
    buildLocatorVehicleDetail,
    ensureLocatorErpVehicle,
} from '../../services/locatorVehicleListService.js';

export const getLocatorVehicleDetail = async (req, res) => {
    try {
        const { deviceId } = req.params;
        const locatorRow = await buildLocatorVehicleDetail(deviceId);

        const asset = await ensureLocatorErpVehicle({
            deviceId,
            deviceName:
                req.query?.locatorName ||
                locatorRow.locator?.deviceName ||
                locatorRow.name ||
                '',
            plateEmirate: locatorRow.plateEmirate,
            plateNumber: locatorRow.plateNumber,
            createdBy: req.user?._id || req.user?.id,
        });

        if (locatorRow.locator?.currentKilometer != null) {
            await AssetItem.updateOne(
                { _id: asset._id },
                { $set: { currentKilometer: locatorRow.locator.currentKilometer } },
            );
        }

        const locatorMeta = {
            locator: locatorRow.locator,
            locatorOwnerName: locatorRow.locatorOwnerName,
            matchedEmployee: locatorRow.matchedEmployee,
            matchedEmployees: locatorRow.matchedEmployees,
            assignmentMismatch: locatorRow.assignmentMismatch,
            locatorListStatus: locatorRow.locatorListStatus,
            isLocatorLinked: true,
        };

        const originalJson = res.json.bind(res);
        res.json = (body) => {
            if (!body || typeof body !== 'object' || Array.isArray(body)) {
                return originalJson(body);
            }
            if (body.message && !body._id) {
                return originalJson(body);
            }

            const merged = { ...body, ...locatorMeta };
            if (locatorRow.locator?.currentKilometer != null) {
                merged.currentKilometer = locatorRow.locator.currentKilometer;
            }
            if (!String(merged.plateNumber || '').trim() && locatorRow.plateNumber && locatorRow.plateNumber !== '—') {
                merged.plateNumber = locatorRow.plateNumber;
            }
            if (!String(merged.plateEmirate || '').trim() && locatorRow.plateEmirate) {
                merged.plateEmirate = locatorRow.plateEmirate;
            }

            return originalJson(merged);
        };

        req.params.id = String(asset._id);
        return await getAssetItemDetail(req, res);
    } catch (error) {
        console.error('[LocatorVehicleDetail] Failed:', error?.message || error);

        return res.status(error?.statusCode || 502).json({
            success: false,
            message: error?.message || 'Failed to load Locator vehicle details',
        });
    }
};
