import mongoose from 'mongoose';
import AssetItem from '../../models/AssetItem.js';
import AssetHistory from '../../models/AssetHistory.js';
import { buildFleetVehicleMongoScope } from '../../utils/fleetVehicleAssetId.js';
import {
    countVehicleServicePendingCompleted,
    isPendingVehicleService,
} from '../../utils/vehicleServicePendingStatus.js';

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
    'pending-inspection',
    'all-handover',
    'pending-handover',
    'assigned-vehicle',
    'unassigned-vehicle',
    'list-vehicle',
];

const HANDOVER_PENDING_COUNT_KEYS = ['pending-inspection', 'pending-handover'];

const HANDOVER_STATUS_ALIASES = {
    all: 'all-handover',
    'pending-hr': 'pending-handover',
    'pending-assignee': 'pending-handover',
    'completed-inspection': 'all-handover',
    'completed-handover': 'all-handover',
};

function normalizeHandoverStatusKey(raw) {
    const key = String(raw || '').trim().toLowerCase();
    if (!key) return '';
    return HANDOVER_STATUS_ALIASES[key] || key;
}

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

function isAssignedVehicle(vehicle) {
    if (isUnassignedVehicle(vehicle)) return false;
    return Boolean(vehicle?.assignedTo || vehicle?.assignedCompany);
}

function neverCompletedFirstInspection(vehicle) {
    if (inspectionStatusKey(vehicle) === 'active') return false;
    if (vehicle?.vehicleInspectionApprovedAt) return false;
    return true;
}

function isInspectionWorkflowOpen(vehicle) {
    const insp = inspectionStatusKey(vehicle);
    return insp === 'draft' || insp === 'pending_hr';
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
    if (history?.details?.hrApprovalSkipped === true) return false;

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
        return stage === 'hr' || stage === 'management' || stage === 'hod';
    }

    const stage = handoverFlowStage(vehicle, history);
    return stage === 'hr' || stage === 'management' || stage === 'hod';
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
    if (String(vehicle?.acceptanceStatus || '').trim() === 'Accepted') return false;

    const lifecycle = String(history?.details?.handoverLifecycleStatus || '').trim().toLowerCase();
    return lifecycle === 'pending' && (stage === 'target' || !stage);
}

function matchesHandoverAccessStatus(statusKey, vehicle, history) {
    switch (statusKey) {
        case 'pending-inspection':
            return neverCompletedFirstInspection(vehicle);
        case 'all-handover':
            return Boolean(history);
        case 'pending-handover':
            if (neverCompletedFirstInspection(vehicle)) return false;
            if (isHandoverWaitingHr(vehicle, history) || isHandoverWaitingAssignee(vehicle, history)) {
                return true;
            }
            return isInspectionWorkflowOpen(vehicle);
        case 'assigned-vehicle':
            return isAssignedVehicle(vehicle);
        case 'unassigned-vehicle':
            return isUnassignedVehicle(vehicle);
        case 'list-vehicle':
            return true;
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
function vehicleHasCompletedService(asset) {
    return Number(countVehicleServicePendingCompleted(asset).completedServiceCount || 0) > 0;
}

export const getVehicleAccessServices = async (req, res) => {
    try {
        const type = String(req.query.type || '').trim();
        const status = String(req.query.status || '').trim().toLowerCase();
        if (type && !SERVICE_TYPES.includes(type)) {
            return res.status(400).json({ message: 'Unknown service type.' });
        }

        const vehicles = await loadFleetVehicles(
            req,
            'assetId name plateEmirate plateNumber currentKilometer oilChangeDate activeServiceWorkflow vehicleProfileActivationStatus assignedTo assignedCompany services',
            [{ path: 'assignedTo', select: 'firstName lastName employeeId' }, { path: 'assignedCompany', select: 'name nickName companyShortName companyName' }],
        );

        if (status === 'not-yet') {
            const items = vehicles.filter((v) => !vehicleHasCompletedService(v));
            return res.json({
                items,
                status: 'not-yet',
                total: items.length,
            });
        }

        if (!type) {
            const counts = Object.fromEntries(SERVICE_TYPES.map((t) => [t, 0]));
            let pendingTotal = 0;
            let completedTotal = 0;
            let notYetTotal = 0;
            for (const v of vehicles) {
                if (!vehicleHasCompletedService(v)) {
                    notYetTotal += 1;
                }
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
                notYetTotal,
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
 * List (status): one row per matching vehicle (latest handover / inspection when present).
 */
export const getVehicleAccessHandovers = async (req, res) => {
    try {
        const statusKey = normalizeHandoverStatusKey(req.query.status);
        if (statusKey && !HANDOVER_ACCESS_STATUS_KEYS.includes(statusKey)) {
            return res.status(400).json({ message: 'Unknown handover status.' });
        }

        const vehicles = await loadFleetVehicles(
            req,
            'assetId name plateEmirate plateNumber status acceptanceStatus pendingAction pendingActionDetails assignmentType assignedDays assignedTo assignedCompany assignedToType assignedDate assignedBy actionRequiredBy vehicleInspectionStatus vehicleInspectionApprovedAt vehicleInspectionHandoverHistoryId',
            [
                { path: 'assignedTo', select: 'firstName lastName employeeId' },
                { path: 'assignedCompany', select: 'name nickName companyId' },
                { path: 'assignedBy', select: 'firstName lastName employeeId' },
                { path: 'actionRequiredBy', select: 'firstName lastName employeeId' },
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
