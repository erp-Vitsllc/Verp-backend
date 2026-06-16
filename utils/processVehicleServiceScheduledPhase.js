import AssetItem from '../models/AssetItem.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { sendVehicleServiceWorkflowEmail } from './sendVehicleServiceWorkflowEmail.js';
import { applyServiceActiveState } from './assetOperationalFlags.js';

const STAGE_SCHEDULED = 'scheduled_service';

/**
 * While a vehicle is in a scheduled in-shop service window (after Admin approval),
 * - move status from "Waiting for Service" to "On Service" on the first service day
 *   through the end of the window, and
 * - once the window end date has passed, email the Asset Controller (once) that the
 *   scheduled duration is complete.
 */
export async function processVehicleServiceScheduledPhase() {
    try {
        const items = await AssetItem.find({ 'activeServiceWorkflow.stage': STAGE_SCHEDULED })
            .select('assetId name plateNumber status activeServiceWorkflow')
            .limit(1000)
            .lean();

        if (!items.length) return;

        const now = new Date();
        const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

        for (const row of items) {
            const wf = row.activeServiceWorkflow;
            if (!wf?.scheduledServiceDate || !wf?.serviceWindowEndDate) continue;

            const s = new Date(wf.scheduledServiceDate);
            const e = new Date(wf.serviceWindowEndDate);
            if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) continue;
            const start = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate());
            const end = Date.UTC(e.getUTCFullYear(), e.getUTCMonth(), e.getUTCDate());

            const asset = await AssetItem.findById(row._id);
            if (!asset) continue;
            const liveWf = asset.activeServiceWorkflow;
            if (!liveWf || liveWf.stage !== STAGE_SCHEDULED) continue;

            let changed = false;

            if (isServiceActive(asset) && today >= start && today <= end) {
                applyServiceActiveState(asset);
                changed = true;
            }

            if (today > end && !liveWf.serviceDurationEmailSentAt) {
                liveWf.serviceDurationEmailSentAt = new Date();
                changed = true;
                const ac = await getDepartmentHOD('assetcontroller');
                if (ac) {
                    await sendVehicleServiceWorkflowEmail({
                        recipient: ac,
                        asset,
                        stageLabel: 'Service window complete',
                        actionLabel: 'Scheduled service duration has ended',
                        detailLine: `The in-shop service window for ${asset.assetId} has passed its end date. Please use Mark live to close (with invoice) or Extend if work continues.`,
                        linkPath: `/HRM/Asset/Vehicle/details/${asset._id}`,
                    });
                }
            }

            if (changed) {
                asset.markModified('activeServiceWorkflow');
                await asset.save();
            }
        }
    } catch (e) {
        console.error('[processVehicleServiceScheduledPhase]', e);
    }
}
