import mongoose from 'mongoose';
import AssetItem from '../../models/AssetItem.js';
import AssetHistory from '../../models/AssetHistory.js';
import { buildFleetVehicleMongoScope } from '../../utils/fleetVehicleAssetId.js';
import { isPendingVehicleService } from '../../utils/vehicleServicePendingStatus.js';

const SERVICE_TYPES = [
    'Oil Service',
    'Tire Change',
    'Mechanical Work',
    'Body Work',
    'Accident Repair',
    'Car Wash',
];

const HANDOVER_ACTIONS = [
    'Assigned',
    'Returned',
    'Unassigned',
    'Accepted',
    'Rejected',
    'ControllerHandover',
    'Transfer',
];

const HANDOVER_ACCESS_STATUS_KEYS = [
    'pending-hr',
    'pending-inspection',
    'completed-inspection',
    'pending-assignee',
    'completed-handover',
    'unassigned-vehicle',
];

const HANDOVER_PENDING_COUNT_KEYS = [
    'pending-inspection',
    'pending-hr',
    'pending-assignee',
    'unassigned-vehicle',
];

function vehicleStatusKey(vehicle) {
    return String(vehicle?.status || '').trim().toLowerCase();
}

function inspectionStatusKey(vehicle) {
    return String(vehicle?.vehicleInspectionStatus || '').trim().toLowerCase();
}

function isUnassignedVehicle(vehicle) {
    const status = vehicleStatusKey(vehicle);
    return status === 'unassigned' || status === 'available' || status === 'returned';
}

function isInspectionHandoverHistory(history, vehicle) {
    if (!history) return false;
    if (String(history?.details?.handoverKind || '').trim() === 'vehicle_inspection') return true;
    if (history?.details?.firstInspection === true || history?.details?.reinspection === true) return true;
    const linkedId = vehicle?.vehicleInspectionHandoverHistoryId;
    return Boolean(linkedId && history?._id && String(linkedId) === String(history._id));
}

function handoverFlowStage(vehicle, history) {
    const flow = vehicle?.pendingActionDetails?.vehicleHandoverFlow;
    if (!flow) return '';
    const linked =
        !history?._id || !flow.historyId || String(flow.historyId) === String(history._id);
    return linked ? String(flow.stage || '').trim().toLowerCase() : '';
}

function isHandoverWaitingHr(vehicle, history) {
    // Inspection waiting HR only when the latest history row is that inspection.
    if (inspectionStatusKey(vehicle) === 'pending_hr') {
        return isInspectionHandoverHistory(history, vehicle);
    }
    if (isInspectionHandoverHistory(history, vehicle)) return false;

    const lifecycle = String(history?.details?.handoverLifecycleStatus || '').trim().toLowerCase();
    if (lifecycle === 'approved') return false;
    if (String(history?.details?.status || '').trim() === 'ApprovedAndFinalized') return false;

    const action = String(history?.action || '').trim();
    if (action === 'Returned' || action === 'Unassigned') {
        const flow = vehicle?.pendingActionDetails?.vehicleHandoverFlow;
        const isLinkedReturn =
            action === 'Returned' &&
            flow?.isReturn &&
            flow?.historyId &&
            history?._id &&
            String(flow.historyId) === String(history._id);
        // Finished return/unassign history must not appear under Pending HR.
        if (!isLinkedReturn) return false;
        const stage = String(flow?.stage || '').toLowerCase();
        return stage === 'hr' || stage === 'management' || stage === 'hod' || lifecycle === 'accepted';
    }

    const stage = handoverFlowStage(vehicle, history);
    if (stage === 'hr' || stage === 'management' || stage === 'hod') return true;
    if (lifecycle === 'accepted') return true;
    return (
        String(vehicle?.acceptanceStatus || '').trim() === 'Accepted' &&
        Boolean(vehicle?.pendingActionDetails?.vehicleHandoverFlow?.stage) &&
        lifecycle !== 'approved'
    );
}

function isHandoverWaitingAssignee(vehicle, history) {
    // Assignment target only (the user the vehicle is being handed to) — not inspection.
    if (isInspectionHandoverHistory(history, vehicle)) return false;
    const insp = inspectionStatusKey(vehicle);
    if (insp === 'draft' || insp === 'pending_hr') return false;

    const hasTarget = Boolean(vehicle?.assignedTo || vehicle?.assignedCompany);
    if (!hasTarget) return false;

    const stage = handoverFlowStage(vehicle, history);
    if (stage === 'hr' || stage === 'management' || stage === 'hod') return false;

    if (String(vehicle?.acceptanceStatus || '').trim() === 'Pending') return true;

    const lifecycle = String(history?.details?.handoverLifecycleStatus || '').trim().toLowerCase();
    return lifecycle === 'pending' && (stage === 'target' || !stage);
}

function isFleetHandoverHrApproved(history) {
    const lifecycle = String(history?.details?.handoverLifecycleStatus || '').trim().toLowerCase();
    if (lifecycle === 'approved') return true;
    if (lifecycle === 'pending' || lifecycle === 'accepted') return false;
    if (history?.details?.handoverHrApprovedAt) return true;
    const hrStage = history?.details?.vehicleHandoverWorkflow?.stages?.hr;
    return Boolean(hrStage?.date);
}

function resolveFleetHandoverLifecycle(vehicle, history) {
    const action = String(history?.action || '').trim();
    const lifecycle = String(history?.details?.handoverLifecycleStatus || '').trim().toLowerCase();

    const flow = vehicle?.pendingActionDetails?.vehicleHandoverFlow;
    const isLinked =
        flow?.historyId && history?._id && String(flow.historyId) === String(history._id);
    const vehicleStatus = String(vehicle?.acceptanceStatus || '').trim();

    if (isLinked && lifecycle !== 'rejected') {
        const stage = String(flow.stage || '').toLowerCase();
        if (stage === 'hr' || stage === 'management' || stage === 'hod') return 'accepted';
        if (stage === 'target' || !stage) return 'pending';
        if (lifecycle === 'approved') return 'approved';
        return 'pending';
    }

    if (lifecycle !== 'rejected' && isFleetHandoverHrApproved(history)) {
        return 'approved';
    }

    if (action === 'Returned' || action === 'Unassigned') {
        const isLinkedReturn =
            action === 'Returned' &&
            flow?.isReturn &&
            flow?.historyId &&
            history?._id &&
            String(flow.historyId) === String(history._id);
        if (isLinkedReturn) {
            if (lifecycle === 'approved') return 'approved';
            const stage = String(flow.stage || '').toLowerCase();
            if (stage === 'hr' || stage === 'management' || stage === 'hod') return 'accepted';
            return 'pending';
        }
        if (lifecycle === 'rejected') return 'rejected';
        if (
            lifecycle === 'approved' ||
            lifecycle === 'accepted' ||
            String(history?.details?.status || '').trim() === 'ApprovedAndFinalized'
        ) {
            return lifecycle === 'accepted' ? 'accepted' : 'approved';
        }
        return 'approved';
    }

    if (
        vehicleStatus === 'Accepted' &&
        !isLinked &&
        (action === 'Assigned' || action === 'Accepted') &&
        (lifecycle === 'accepted' ||
            lifecycle === 'approved' ||
            Boolean(history?.details?.vehicleHandoverWorkflow?.stages?.target?.date))
    ) {
        return 'approved';
    }

    if (isLinked && lifecycle !== 'rejected') {
        if (lifecycle === 'approved') return 'approved';
        const stage = String(flow.stage || '').toLowerCase();
        if (stage === 'hr' || stage === 'management' || stage === 'hod') return 'accepted';
        return 'pending';
    }

    if (lifecycle === 'approved' || lifecycle === 'accepted' || lifecycle === 'pending' || lifecycle === 'rejected') {
        return lifecycle;
    }

    if (action === 'Accepted') {
        if (lifecycle === 'approved') return 'approved';
        return 'accepted';
    }

    if (action === 'Assigned') {
        if (String(history?.details?.acceptanceStatus || '').trim() === 'Accepted') {
            return 'accepted';
        }
        return 'pending';
    }

    return 'pending';
}

function isCompletedAssignmentHandover(vehicle, history) {
    if (!history || isInspectionHandoverHistory(history, vehicle)) return false;
    if (isHandoverWaitingHr(vehicle, history) || isHandoverWaitingAssignee(vehicle, history)) return false;

    const resolvedLifecycle = resolveFleetHandoverLifecycle(vehicle, history);
    if (resolvedLifecycle === 'approved') return true;

    if (resolvedLifecycle === 'rejected' || resolvedLifecycle === 'pending' || resolvedLifecycle === 'accepted') {
        return false;
    }

    const action = String(history?.action || '').trim();
    if (action === 'Returned' || action === 'Unassigned') return true;
    if (
        String(vehicle?.acceptanceStatus || '').trim() === 'Accepted' &&
        ['Assigned', 'Accepted', 'Transfer', 'ControllerHandover'].includes(action)
    ) {
        return true;
    }
    return String(history?.details?.status || '').trim() === 'ApprovedAndFinalized';
}

function matchesHandoverAccessStatus(statusKey, vehicle, history) {
    switch (statusKey) {
        case 'pending-inspection':
            return inspectionStatusKey(vehicle) === 'draft';
        case 'completed-inspection':
            return inspectionStatusKey(vehicle) === 'active';
        case 'pending-hr':
            return isHandoverWaitingHr(vehicle, history);
        case 'pending-assignee':
            return isHandoverWaitingAssignee(vehicle, history);
        case 'completed-handover':
            return isCompletedAssignmentHandover(vehicle, history);
        case 'unassigned-vehicle':
            return isUnassignedVehicle(vehicle);
        default:
            return false;
    }
}

function draftVisibilityQuery(reqUser) {
    const uid = reqUser?._id || reqUser?.id;
    if (uid && mongoose.Types.ObjectId.isValid(String(uid))) {
        return {
            $or: [{ status: { $ne: 'Draft' } }, { createdBy: new mongoose.Types.ObjectId(String(uid)) }],
        };
    }
    return { status: { $ne: 'Draft' } };
}

function parseServiceRemark(service) {
    try {
        return service?.remark ? JSON.parse(service.remark) : {};
    } catch {
        return {};
    }
}

function serviceTypeKey(service) {
    const st = String(service?.serviceType || '').trim();
    if (st) return st;
    return String(parseServiceRemark(service)?.serviceType || '').trim();
}

async function loadFleetVehicles(req, select, populate = []) {
    let query = AssetItem.find({
        $and: [draftVisibilityQuery(req.user), buildFleetVehicleMongoScope()],
    }).select(select);
    for (const pop of populate) {
        query = query.populate(pop);
    }
    const vehicles = await query.lean();
    return vehicles.filter((v) => String(v.plateNumber || '').trim() || String(v.assetId || '').startsWith('VEGA-VHCL-'));
}

/**
 * GET /api/AssetItem/vehicle-access-services?type=Oil Service
 * Vehicles with services of that type — same payload shape the details Service tab builders use.
 */
export const getVehicleAccessServices = async (req, res) => {
    try {
        const type = String(req.query.type || '').trim();
        if (type && !SERVICE_TYPES.includes(type)) {
            return res.status(400).json({ message: 'Unknown service type.' });
        }

        const vehicles = await loadFleetVehicles(
            req,
            'assetId name plateEmirate plateNumber currentKilometer oilChangeDate activeServiceWorkflow vehicleProfileActivationStatus services',
        );

        if (!type) {
            const counts = Object.fromEntries(SERVICE_TYPES.map((t) => [t, 0]));
            let pendingTotal = 0;
            let completedTotal = 0;
            for (const v of vehicles) {
                for (const s of v.services || []) {
                    const key = serviceTypeKey(s);
                    if (counts[key] == null) continue;
                    if (isPendingVehicleService(v, s)) {
                        counts[key] += 1;
                        pendingTotal += 1;
                    } else {
                        completedTotal += 1;
                    }
                }
            }
            return res.json({
                counts,
                total: pendingTotal,
                pendingTotal,
                completedTotal,
            });
        }

        const items = vehicles
            .map((v) => ({
                ...v,
                services: (v.services || []).filter((s) => serviceTypeKey(s) === type),
            }))
            .filter((v) => v.services.length);

        return res.json({ items, type, total: items.reduce((n, v) => n + v.services.length, 0) });
    } catch (error) {
        console.error('[getVehicleAccessServices]', error);
        return res.status(500).json({ message: error.message || 'Server Error' });
    }
};

/**
 * GET /api/AssetItem/vehicle-access-handovers?status=pending-inspection
 * Hub (no status): counts per handover access box.
 * List (status): latest handover row for vehicles in that box.
 */
export const getVehicleAccessHandovers = async (req, res) => {
    try {
        const statusKey = String(req.query.status || '').trim().toLowerCase();
        if (statusKey && !HANDOVER_ACCESS_STATUS_KEYS.includes(statusKey)) {
            return res.status(400).json({ message: 'Unknown handover status.' });
        }

        const vehicles = await loadFleetVehicles(
            req,
            'assetId name plateEmirate plateNumber status acceptanceStatus pendingAction pendingActionDetails assignmentType assignedDays assignedTo assignedCompany assignedToType assignedDate assignedBy vehicleInspectionStatus vehicleInspectionHandoverHistoryId',
            [
                { path: 'assignedTo', select: 'firstName lastName employeeId' },
                { path: 'assignedCompany', select: 'name companyId' },
                { path: 'assignedBy', select: 'firstName lastName employeeId' },
            ],
        );
        const vehicleIds = vehicles.map((v) => v._id);
        if (!vehicleIds.length) {
            const counts = Object.fromEntries(HANDOVER_ACCESS_STATUS_KEYS.map((key) => [key, 0]));
            return res.json({ items: [], counts, total: 0 });
        }

        const latest = await AssetHistory.aggregate([
            {
                $match: {
                    assetId: { $in: vehicleIds },
                    action: { $in: HANDOVER_ACTIONS },
                },
            },
            { $sort: { date: -1, createdAt: -1 } },
            { $group: { _id: '$assetId', historyId: { $first: '$_id' } } },
        ]);

        const historyIds = latest.map((row) => row.historyId).filter(Boolean);
        const histories = historyIds.length
            ? await AssetHistory.find({ _id: { $in: historyIds } })
                  .select(
                      'assetId action date createdAt comments assignedTo assignedCompany assignedToType performedBy details.assignmentReason details.handoverLifecycleStatus details.handoverKind details.firstInspection details.reinspection details.inspectionFormStatus details.receiverAssessmentCompleted details.handoverHrApprovedAt details.hrApprovalSkipped details.assignmentType details.assignedDays details.acceptanceStatus details.handoverByDisplay details.handoverToDisplay details.vehicleHandoverWorkflow details.assignedTo details.assignedCompany details.status details.ApprovedAndFinalized',
                  )
                  .populate('performedBy', 'firstName lastName employeeId')
                  .populate('assignedTo', 'firstName lastName employeeId')
                  .populate('assignedCompany', 'name companyId')
                  .lean()
            : [];

        const historyByAsset = new Map(histories.map((h) => [String(h.assetId), h]));
        const allItems = vehicles.map((vehicle) => ({
            vehicle,
            history: historyByAsset.get(String(vehicle._id)) || null,
        }));

        if (!statusKey) {
            const counts = Object.fromEntries(HANDOVER_ACCESS_STATUS_KEYS.map((key) => [key, 0]));
            for (const item of allItems) {
                for (const key of HANDOVER_ACCESS_STATUS_KEYS) {
                    if (matchesHandoverAccessStatus(key, item.vehicle, item.history)) {
                        counts[key] += 1;
                    }
                }
            }
            const total = HANDOVER_PENDING_COUNT_KEYS.reduce((sum, key) => sum + Number(counts[key] || 0), 0);
            return res.json({ counts, total });
        }

        const items = allItems.filter((item) =>
            matchesHandoverAccessStatus(statusKey, item.vehicle, item.history),
        );
        items.sort((a, b) => {
            const ta = new Date(a.history?.date || a.history?.createdAt || 0).getTime();
            const tb = new Date(b.history?.date || b.history?.createdAt || 0).getTime();
            return tb - ta;
        });

        return res.json({ items, status: statusKey, total: items.length });
    } catch (error) {
        console.error('[getVehicleAccessHandovers]', error);
        return res.status(500).json({ message: error.message || 'Server Error' });
    }
};
