import AssetItem from '../models/AssetItem.js';
import AssetHistory from '../models/AssetHistory.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { isFleetVehicleAssetFields } from './assetApprovalHelpers.js';
import {
    FLEET_HANDOVER_AUTO_ACCEPT_DAY,
    FLEET_HANDOVER_REMINDER_START_DAY,
    autoAcceptFleetHandoverTargetStage,
    getHandoverEscalationDaysElapsed,
    refreshHandoverEscalationReminders,
} from './vehicleHandoverEscalation.js';
import {
    getVehicleHandoverFlow,
    resolveAdminOfficerEmployee,
    resolveFleetHandoverFirstActor,
} from './vehicleHandoverApprovalFlow.js';

async function resolveEscalationRequestedAt(flow, historyId) {
    if (flow?.escalation?.requestedAt) return new Date(flow.escalation.requestedAt);
    if (!historyId) return null;
    const history = await AssetHistory.findById(historyId).select('createdAt date').lean();
    return history?.createdAt || history?.date || null;
}

export const processFleetHandoverEscalation = async () => {
    try {
        const candidates = await AssetItem.find({
            status: 'Pending',
            acceptanceStatus: 'Pending',
            assignedToType: 'Employee',
            'pendingActionDetails.vehicleHandoverFlow.stage': 'target',
            $and: [
                {
                    $or: [
                        {
                            'pendingActionDetails.vehicleHandoverFlow.escalation.autoAcceptedAt': {
                                $exists: false,
                            },
                        },
                        { 'pendingActionDetails.vehicleHandoverFlow.escalation.autoAcceptedAt': null },
                    ],
                },
                {
                    $or: [
                        {
                            'pendingActionDetails.vehicleHandoverFlow.escalation.resolvedAt': {
                                $exists: false,
                            },
                        },
                        { 'pendingActionDetails.vehicleHandoverFlow.escalation.resolvedAt': null },
                    ],
                },
            ],
        })
            .select(
                'assetId name plateNumber status acceptanceStatus assignedTo assignedBy pendingActionDetails typeId vehicleInspectionStatus',
            )
            .populate('typeId', 'name')
            .limit(200)
            .lean();

        const adminOfficer = await resolveAdminOfficerEmployee();

        for (const lean of candidates) {
            const inspectionStatus = String(lean.vehicleInspectionStatus || '').toLowerCase();
            if (inspectionStatus === 'draft' || inspectionStatus === 'pending_hr') continue;
            if (
                !isFleetVehicleAssetFields({
                    plateNumber: lean.plateNumber,
                    typeName: lean.typeId?.name,
                })
            ) {
                continue;
            }

            const flow = getVehicleHandoverFlow(lean);
            if (!flow?.historyId) continue;

            const requestedAt = await resolveEscalationRequestedAt(flow, flow.historyId);
            if (!requestedAt) continue;

            const daysElapsed = getHandoverEscalationDaysElapsed(requestedAt);
            if (daysElapsed < FLEET_HANDOVER_REMINDER_START_DAY) continue;

            const assigneeId = lean.assignedTo?._id || lean.assignedTo;
            const assigneeDoc = assigneeId
                ? await EmployeeBasic.findById(assigneeId)
                      .select(
                          'firstName lastName employeeId companyEmail workEmail personalEmail email enablePortalAccess primaryReportee',
                      )
                      .lean()
                : null;
            if (!assigneeDoc?._id) continue;

            const assignerId = lean.assignedBy?._id || lean.assignedBy;
            const assigner = assignerId
                ? await EmployeeBasic.findById(assignerId).select('firstName lastName employeeId').lean()
                : null;

            const fleetActor = await resolveFleetHandoverFirstActor(assigneeDoc);
            const actionRecipient = fleetActor?.actorDoc || adminOfficer;

            if (daysElapsed >= FLEET_HANDOVER_AUTO_ACCEPT_DAY) {
                const item = await AssetItem.findById(lean._id);
                if (!item) continue;
                const result = await autoAcceptFleetHandoverTargetStage(item);
                if (!result.ok) {
                    console.warn(
                        `[processFleetHandoverEscalation] auto-accept skipped for ${lean.assetId || lean._id}: ${result.reason}`,
                    );
                }
                continue;
            }

            const lastReminderDay = flow.escalation?.lastReminderDay;
            if (lastReminderDay != null && Number(lastReminderDay) >= daysElapsed) continue;

            await refreshHandoverEscalationReminders({
                asset: lean,
                historyId: flow.historyId,
                assigner,
                assigneeDoc,
                actionRecipient,
                adminOfficer,
                daysElapsed,
            });

            await AssetItem.updateOne(
                { _id: lean._id },
                {
                    $set: {
                        'pendingActionDetails.vehicleHandoverFlow.escalation.lastReminderDay': daysElapsed,
                        'pendingActionDetails.vehicleHandoverFlow.escalation.lastReminderSentAt': new Date(),
                        ...(flow.escalation?.requestedAt
                            ? {}
                            : { 'pendingActionDetails.vehicleHandoverFlow.escalation.requestedAt': requestedAt }),
                    },
                },
            );
        }
    } catch (e) {
        console.error('[processFleetHandoverEscalation] Non-fatal error:', e?.message || e);
    }
};
