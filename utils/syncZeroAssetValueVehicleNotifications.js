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

let lastVehicleSweepAt = 0;
let lastToolsSweepAt = 0;

function isZeroAssetValue(asset) {
    const n = Number(asset?.assetValue);
    return !Number.isFinite(n) || n <= 0;
}

function isFleetVehicle(asset) {
    return isFleetVehicleAsset(asset);
}

function isDisposed(asset) {
    const status = String(asset?.vehicleDispositionStatus || '').toLowerCase().trim();
    return status === 'sold' || status === 'total loss';
}

async function resolveAssetController() {
    const raw = await getDepartmentHOD('assetcontroller');
    if (!raw) return null;
    return resolveAssetControllerEmployee(raw);
}

async function closeZeroValueNotifications(assetId, requestType, comment) {
    if (!assetId || !requestType) return;
    await DashboardAction.updateMany(
        {
            requestId: assetId,
            requestType,
            status: 'Pending',
        },
        {
            $set: {
                status: 'Approved',
                actionedDate: new Date(),
                comment,
            },
        },
    );
}

export async function syncZeroAssetValueVehicleNotification(asset) {
    if (!asset?._id || !isFleetVehicle(asset)) return { ok: false, skipped: true };
    if (!isZeroAssetValue(asset) || isDisposed(asset)) {
        await closeZeroValueNotifications(asset._id, VEHICLE_ZERO_VALUE_REQUEST_TYPE, 'Vehicle value is set.');
        return { ok: true, closed: true };
    }

    const controller = await resolveAssetController();
    if (!controller?._id) return { ok: false, skipped: true, reason: 'no_asset_controller' };

    const plate = [asset.plateEmirate, asset.plateNumber].filter(Boolean).join(' ').trim();
    const name = String(asset.name || '').trim();
    const code = String(asset.assetId || 'Vehicle').trim();
    const label = [code, name].filter(Boolean).join(' — ');
    const extra1 = `${label}${plate ? ` (${plate})` : ''} — vehicle value is 0`;

    await DashboardAction.findOneAndUpdate(
        {
            requestId: asset._id,
            requestType: VEHICLE_ZERO_VALUE_REQUEST_TYPE,
            status: 'Pending',
            assignedTo: controller._id,
        },
        {
            assignedTo: controller._id,
            assignedToEmpId: controller.employeeId || '',
            requestId: asset._id,
            requestType: VEHICLE_ZERO_VALUE_REQUEST_TYPE,
            status: 'Pending',
            subjectEmployeeId: asset.assetId || '',
            subjectName: name || 'Vehicle',
            requestedByName: 'System',
            extra1,
            extra2: 'Set the vehicle value',
            extra3: JSON.stringify({
                isFleetVehicle: true,
                vehicleMongoId: String(asset._id),
                vehicleTab: 'basic',
                focusCard: 'basicDetails',
            }),
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return { ok: true, created: true };
}

export async function syncZeroAssetValueToolsNotification(asset) {
    if (!asset?._id || isFleetVehicle(asset)) return { ok: false, skipped: true };
    if (!isZeroAssetValue(asset)) {
        await closeZeroValueNotifications(asset._id, TOOLS_ZERO_VALUE_REQUEST_TYPE, 'Asset value is set.');
        return { ok: true, closed: true };
    }

    const controller = await resolveAssetController();
    if (!controller?._id) return { ok: false, skipped: true, reason: 'no_asset_controller' };

    const name = String(asset.name || '').trim();
    const code = String(asset.assetId || 'Asset').trim();
    const label = [code, name].filter(Boolean).join(' — ');

    await DashboardAction.findOneAndUpdate(
        {
            requestId: asset._id,
            requestType: TOOLS_ZERO_VALUE_REQUEST_TYPE,
            status: 'Pending',
            assignedTo: controller._id,
        },
        {
            $set: {
                assignedTo: controller._id,
                assignedToEmpId: controller.employeeId || '',
                requestId: asset._id,
                requestType: TOOLS_ZERO_VALUE_REQUEST_TYPE,
                status: 'Pending',
                subjectEmployeeId: asset.assetId || '',
                subjectName: name || 'Asset',
                requestedByName: 'System',
                extra1: `${label} — asset value is 0`,
                extra2: 'Set the asset value',
                extra3: JSON.stringify({
                    isFleetVehicle: false,
                    focusCard: 'basicDetails',
                }),
            },
            $setOnInsert: {
                requestedDate: asset.createdAt || new Date(),
            },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return { ok: true, created: true };
}

/** Route a saved asset to the vehicle inbox or the tools inbox. */
export async function syncZeroAssetValueNotification(asset) {
    if (!asset?._id) return { ok: false, skipped: true };
    if (isFleetVehicle(asset)) {
        await closeZeroValueNotifications(asset._id, TOOLS_ZERO_VALUE_REQUEST_TYPE, 'This is a vehicle.');
        return syncZeroAssetValueVehicleNotification(asset);
    }
    await closeZeroValueNotifications(asset._id, VEHICLE_ZERO_VALUE_REQUEST_TYPE, 'This is a tools asset.');
    return syncZeroAssetValueToolsNotification(asset);
}

/** Refresh Asset Controller rows for vehicles still at value 0. Throttled. */
export async function syncAllZeroAssetValueVehicleNotifications() {
    const now = Date.now();
    if (now - lastVehicleSweepAt < 60 * 1000) return { ok: true, skipped: true };
    lastVehicleSweepAt = now;
    try {
        const vehicles = await AssetItem.find({
            plateNumber: { $exists: true, $nin: [null, ''] },
            vehicleDispositionStatus: { $nin: ['sold', 'total loss'] },
            status: { $ne: 'Deleted' },
            $or: [
                { assetValue: { $lte: 0 } },
                { assetValue: null },
                { assetValue: { $exists: false } },
            ],
        })
            .select('assetId name plateNumber plateEmirate assetValue vehicleDispositionStatus status')
            .limit(300)
            .lean();

        for (const vehicle of vehicles) {
            await syncZeroAssetValueVehicleNotification(vehicle);
        }

        const pending = await DashboardAction.find({
            requestType: VEHICLE_ZERO_VALUE_REQUEST_TYPE,
            status: 'Pending',
        })
            .select('requestId')
            .lean();
        const ids = pending.map((row) => row.requestId).filter(Boolean);
        if (ids.length) {
            const valued = await AssetItem.find({
                _id: { $in: ids },
                assetValue: { $gt: 0 },
            })
                .select('_id')
                .lean();
            await Promise.all(
                valued.map((row) =>
                    closeZeroValueNotifications(row._id, VEHICLE_ZERO_VALUE_REQUEST_TYPE, 'Vehicle value is set.'),
                ),
            );
        }
        return { ok: true, count: vehicles.length };
    } catch (err) {
        lastVehicleSweepAt = 0;
        console.error('[syncAllZeroAssetValueVehicleNotifications]', err?.message || err);
        return { ok: false };
    }
}

/** Refresh Asset Controller rows for tools still at value 0. Throttled. */
export async function syncAllZeroAssetValueToolsNotifications() {
    const now = Date.now();
    if (now - lastToolsSweepAt < 60 * 1000) return { ok: true, skipped: true };
    lastToolsSweepAt = now;
    try {
        const tools = await AssetItem.find({
            $nor: [buildFleetVehicleMongoScope()],
            status: { $ne: 'Deleted' },
            $or: [
                { assetValue: { $lte: 0 } },
                { assetValue: null },
                { assetValue: { $exists: false } },
            ],
        })
            .select('assetId name assetValue status createdAt plateNumber vehicleBrand typeId')
            .limit(300)
            .lean();

        for (const tool of tools) {
            await syncZeroAssetValueToolsNotification(tool);
        }

        const pending = await DashboardAction.find({
            requestType: TOOLS_ZERO_VALUE_REQUEST_TYPE,
            status: 'Pending',
        })
            .select('requestId')
            .lean();
        const ids = pending.map((row) => row.requestId).filter(Boolean);
        if (ids.length) {
            const valued = await AssetItem.find({
                _id: { $in: ids },
                assetValue: { $gt: 0 },
            })
                .select('_id')
                .lean();
            await Promise.all(
                valued.map((row) =>
                    closeZeroValueNotifications(row._id, TOOLS_ZERO_VALUE_REQUEST_TYPE, 'Asset value is set.'),
                ),
            );
        }
        return { ok: true, count: tools.length };
    } catch (err) {
        lastToolsSweepAt = 0;
        console.error('[syncAllZeroAssetValueToolsNotifications]', err?.message || err);
        return { ok: false };
    }
}
