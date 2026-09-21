import { isFleetVehicleAsset } from './assetApprovalHelpers.js';

/**
 * Keeps the old vehicle assign/reassign/handover email blast off.
 * New one-message-per-person sends live in sendVehicleHandoverLifecycleMessages.js.
 */
export const VEHICLE_HANDOVER_EMAILS_ENABLED = false;

export function skipVehicleHandoverEmail(asset) {
    if (VEHICLE_HANDOVER_EMAILS_ENABLED) return false;
    return isFleetVehicleAsset(asset);
}
