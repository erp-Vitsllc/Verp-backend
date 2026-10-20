import VehicleFuelBill from '../models/VehicleFuelBill.js';
import { isPendingVehicleService } from './vehicleServicePendingStatus.js';

export const SOLD_VEHICLE_LOCKED_MESSAGE =
    'This vehicle is sold. It cannot be assigned, serviced, fuelled, or changed.';

export function dubaiMonthKey(date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Dubai',
        year: 'numeric',
        month: '2-digit',
    })
        .format(date)
        .slice(0, 7);
}

export function isVehicleSold(asset) {
    return String(asset?.vehicleDispositionStatus || '').trim().toLowerCase() === 'sold';
}

function vehicleIsAssigned(asset) {
    if (asset?.assignedTo || asset?.assignedCompany) return true;
    const status = String(asset?.status || '').trim().toLowerCase();
    if (status === 'assigned') return true;
    const pending = String(asset?.pendingAction || '').trim().toLowerCase();
    return pending.includes('assign');
}

function vehicleHasPendingService(asset) {
    return (asset?.services || []).some((row) => isPendingVehicleService(asset, row));
}

export async function evaluateVehicleSoldChecks(asset) {
    const monthKey = dubaiMonthKey();
    const bill = asset?._id
        ? await VehicleFuelBill.findOne({ vehicleId: asset._id, monthKey })
            .select('entries amountUsed')
            .lean()
        : null;
    const fuelAdded = !!(
        bill &&
        ((Array.isArray(bill.entries) && bill.entries.length > 0) || Number(bill.amountUsed) > 0)
    );

    const checks = [
        {
            key: 'unassigned',
            label: 'Vehicle must be unassigned',
            passed: !vehicleIsAssigned(asset),
            detail: vehicleIsAssigned(asset)
                ? 'Unassign this vehicle before it can be sold.'
                : 'Vehicle is unassigned.',
        },
        {
            key: 'noPendingService',
            label: 'No service is pending',
            passed: !vehicleHasPendingService(asset),
            detail: vehicleHasPendingService(asset)
                ? 'Finish or cancel the open service before selling.'
                : 'No pending service.',
        },
        {
            key: 'noCurrentFuel',
            label: 'No fuel added for the current month',
            passed: !fuelAdded,
            detail: fuelAdded
                ? `Fuel is already added for ${monthKey}. Remove it before selling.`
                : `No fuel added for ${monthKey}.`,
        },
    ];

    return {
        monthKey,
        alreadySold: isVehicleSold(asset),
        canSell: checks.every((row) => row.passed) && !isVehicleSold(asset),
        checks,
    };
}
