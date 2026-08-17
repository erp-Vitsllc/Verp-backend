import mongoose from 'mongoose';
import AssetItem from '../../models/AssetItem.js';
import AssetHistory from '../../models/AssetHistory.js';
import { buildFleetVehicleMongoScope } from '../../utils/fleetVehicleAssetId.js';

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

function draftVisibilityQuery(reqUser) {
    const uid = reqUser?._id || reqUser?.id;
    if (uid && mongoose.Types.ObjectId.isValid(String(uid))) {
        return {
            $or: [{ status: { $ne: 'Draft' } }, { createdBy: new mongoose.Types.ObjectId(String(uid)) }],
        };
    }
    return { status: { $ne: 'Draft' } };
}

function serviceTypeKey(service) {
    const st = String(service?.serviceType || '').trim();
    if (st) return st;
    try {
        const remark = service?.remark ? JSON.parse(service.remark) : null;
        return String(remark?.serviceType || '').trim();
    } catch {
        return '';
    }
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
            for (const v of vehicles) {
                for (const s of v.services || []) {
                    const key = serviceTypeKey(s);
                    if (counts[key] != null) counts[key] += 1;
                }
            }
            return res.json({ counts });
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
 * GET /api/AssetItem/vehicle-access-handovers
 * Latest handover history row for every fleet vehicle.
 */
export const getVehicleAccessHandovers = async (req, res) => {
    try {
        const vehicles = await loadFleetVehicles(
            req,
            'assetId name plateEmirate plateNumber acceptanceStatus pendingActionDetails assignmentType assignedDays assignedTo assignedCompany assignedToType assignedDate assignedBy',
            [
                { path: 'assignedTo', select: 'firstName lastName employeeId' },
                { path: 'assignedCompany', select: 'name companyId' },
                { path: 'assignedBy', select: 'firstName lastName employeeId' },
            ],
        );
        const vehicleIds = vehicles.map((v) => v._id);
        if (!vehicleIds.length) return res.json({ items: [] });

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
                      'assetId action date createdAt comments assignedTo assignedCompany assignedToType performedBy details.assignmentReason details.handoverLifecycleStatus details.handoverKind details.handoverHrApprovedAt details.hrApprovalSkipped details.assignmentType details.assignedDays details.acceptanceStatus details.handoverByDisplay details.handoverToDisplay details.vehicleHandoverWorkflow details.assignedTo details.assignedCompany details.status details.ApprovedAndFinalized',
                  )
                  .populate('performedBy', 'firstName lastName employeeId')
                  .populate('assignedTo', 'firstName lastName employeeId')
                  .populate('assignedCompany', 'name companyId')
                  .lean()
            : [];

        const historyByAsset = new Map(histories.map((h) => [String(h.assetId), h]));
        const items = vehicles.map((vehicle) => ({
            vehicle,
            history: historyByAsset.get(String(vehicle._id)) || null,
        }));

        items.sort((a, b) => {
            const ta = new Date(a.history?.date || a.history?.createdAt || 0).getTime();
            const tb = new Date(b.history?.date || b.history?.createdAt || 0).getTime();
            return tb - ta;
        });

        return res.json({ items, total: items.length });
    } catch (error) {
        console.error('[getVehicleAccessHandovers]', error);
        return res.status(500).json({ message: error.message || 'Server Error' });
    }
};
