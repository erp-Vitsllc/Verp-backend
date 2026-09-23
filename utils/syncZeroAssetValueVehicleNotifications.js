/**
 * Fleet vehicles saved with value 0 belong in the Asset Controller vehicle inbox
 * until a real value is entered.
 */

import AssetItem from '../models/AssetItem.js';
import DashboardAction from '../models/DashboardAction.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { isFleetVehicleAsset, resolveAssetControllerEmployee } from './assetApprovalHelpers.js';
import { buildFleetVehicleMongoScope } from './fleetVehicleAssetId.js';

export const VEHICLE_ZERO_VALUE_REQUEST_TYPE = 'Vehicle Value Missing';
export const TOOLS_ZERO_VALUE_REQUEST_TYPE = 'Asset Value Missing';

function isFleetVehicle(asset) {
    return isFleetVehicleAsset(asset);
}

async function resolveAssetController() {
    const raw = await getDepartmentHOD('assetcontroller');
    if (!raw) return null;
    return resolveAssetControllerEmployee(raw);
}

const ZERO_VALUE_FILTER = {
    status: { $ne: 'Deleted' },
    $or: [
        { assetValue: { $lte: 0 } },
        { assetValue: null },
        { assetValue: { $exists: false } },
    ],
};

function vehicleCountMessage(count) {
    return `${count} number of vehicle's value is not added`;
}

function toolsCountMessage(count) {
    return `${count} number of tools value is not added`;
}

async function replaceWithSingleCountNotice({ requestType, count, message, controller, isFleetVehicle }) {
    await DashboardAction.updateMany(
        { requestType, status: 'Pending' },
        {
            $set: {
                status: 'Approved',
                actionedDate: new Date(),
                comment: 'Combined into one value reminder.',
            },
        },
    );
    if (!count || !controller?._id) return { ok: true, count: 0 };

    await DashboardAction.create({
        assignedTo: controller._id,
        assignedToEmpId: controller.employeeId || '',
        requestId: controller._id,
        requestType,
        status: 'Pending',
        subjectName: '',
        requestedByName: '',
        extra1: message,
        extra2: '',
        extra3: JSON.stringify({
            zeroValueSummary: true,
            count,
            isFleetVehicle: isFleetVehicle === true,
        }),
    });
    return { ok: true, count };
}

export async function syncZeroAssetValueVehicleNotification() {
    const [count, controller] = await Promise.all([
        AssetItem.countDocuments({
            $and: [
                ZERO_VALUE_FILTER,
                buildFleetVehicleMongoScope(),
                { vehicleDispositionStatus: { $nin: ['sold', 'total loss'] } },
            ],
        }),
        resolveAssetController(),
    ]);
    return replaceWithSingleCountNotice({
        requestType: VEHICLE_ZERO_VALUE_REQUEST_TYPE,
        count,
        message: vehicleCountMessage(count),
        controller,
        isFleetVehicle: true,
    });
}

export async function syncZeroAssetValueToolsNotification() {
    const [count, controller] = await Promise.all([
        AssetItem.countDocuments({
            $and: [
                ZERO_VALUE_FILTER,
                { $nor: [buildFleetVehicleMongoScope()] },
            ],
        }),
        resolveAssetController(),
    ]);
    return replaceWithSingleCountNotice({
        requestType: TOOLS_ZERO_VALUE_REQUEST_TYPE,
        count,
        message: toolsCountMessage(count),
        controller,
        isFleetVehicle: false,
    });
}

/** Route a saved asset into the single vehicle or tools value reminder. */
export async function syncZeroAssetValueNotification(asset) {
    if (!asset?._id) return { ok: false, skipped: true };
    if (isFleetVehicle(asset)) return syncZeroAssetValueVehicleNotification();
    return syncZeroAssetValueToolsNotification();
}

export async function syncAllZeroAssetValueVehicleNotifications() {
    try {
        return await syncZeroAssetValueVehicleNotification();
    } catch (err) {
        console.error('[syncAllZeroAssetValueVehicleNotifications]', err?.message || err);
        return { ok: false };
    }
}

export async function syncAllZeroAssetValueToolsNotifications() {
    try {
        return await syncZeroAssetValueToolsNotification();
    } catch (err) {
        console.error('[syncAllZeroAssetValueToolsNotifications]', err?.message || err);
        return { ok: false };
    }
}
