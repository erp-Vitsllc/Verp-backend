import mongoose from 'mongoose';
import AssetItem from '../models/AssetItem.js';
import AssetHistory from '../models/AssetHistory.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import DashboardAction from '../models/DashboardAction.js';
import { getDepartmentHOD, isUserInFlowchart } from '../utils/getDepartmentHOD.js';
import { sendOwnerOnDutyRequestEmail } from '../utils/sendOwnerOnDutyRequestEmail.js';
import { sendOwnerOnDutyResponseEmail } from '../utils/sendOwnerOnDutyResponseEmail.js';
import { resolveFrontendBaseUrl } from '../utils/resolveFrontendBaseUrl.js';

const OWNER_ON_DUTY_REQUEST_TYPE = 'Asset Owner On Duty';

const isParkingStatus = (status) => String(status || '').toLowerCase().trim() === 'on leave';

const applyOnDutyToAsset = async (item, performedBy) => {
    const prevAssignedTo = item.assignedTo?._id || item.assignedTo;
    const snapshot = item.toObject();

    if (!item.assignedTo) {
        throw new Error(`Asset ${item.assetId} has no assignee`);
    }

    item.status = 'Assigned';
    const originalDuration = item.onLeaveDuration;

    if (originalDuration) {
        item.onLeaveStartDate = new Date();
        item.onLeaveDuration = originalDuration;
        const endDate = new Date();
        endDate.setDate(endDate.getDate() + Number(originalDuration));
        item.onLeaveEndDate = endDate;
    } else {
        item.onLeaveStartDate = null;
        item.onLeaveEndDate = null;
        item.onLeaveDuration = null;
        item.parkingExtendedDays = 0;
        item.parkingReminderSentAt = null;
        item.parkingDurationCompleteSentAt = null;
    }

    await item.save();

    await AssetHistory.create({
        assetId: item._id,
        action: 'Assigned',
        assignedTo: prevAssignedTo,
        performedBy,
        comments: `Asset moved to On Duty by owner confirmation${originalDuration ? ` (duration tracking: ${originalDuration} day(s))` : ''}.`,
        date: new Date(),
        details: {
            previousStatus: snapshot.status,
            duration: originalDuration,
            ownerOnDutyConfirm: true,
        },
    });
};

const findParkingAssetsForOwner = async (ownerId) =>
    AssetItem.find({
        status: 'On Leave',
        assignedToType: 'Employee',
        assignedTo: ownerId,
    })
        .select('assetId name status assignedTo onLeaveEndDate onLeaveStartDate onLeaveDuration')
        .sort({ assetId: 1 })
        .lean();

const assertAssetController = async (req) => {
    const isAdmin = req.user?.isAdmin === true || req.user?.role === 'Admin' || req.user?.role === 'ROOT';
    const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller').catch(() => false);
    if (!isAdmin && !isAssetController) {
        const err = new Error('Only Asset Controller or Admin can request owner on duty confirmation.');
        err.status = 403;
        throw err;
    }
};

const assertOwnerOrDelegate = async (req, ownerId) => {
    const actingId = req.user?.employeeObjectId?.toString?.();
    const ownerIdStr = ownerId?.toString?.();
    if (actingId && ownerIdStr && actingId === ownerIdStr) return true;

    const owner = await EmployeeBasic.findById(ownerId).select('primaryReportee').lean();
    const reporteeId = owner?.primaryReportee?.toString?.() || owner?.primaryReportee?.toString?.();
    if (actingId && reporteeId && actingId === reporteeId) return true;

    const isAdmin = req.user?.isAdmin === true || req.user?.role === 'Admin' || req.user?.role === 'ROOT';
    if (isAdmin) return true;

    const err = new Error('Only the asset owner (or their delegate) can respond to this request.');
    err.status = 403;
    throw err;
};

/**
 * @route POST /api/AssetItem/owner-on-duty/request
 */
export const requestOwnerOnDuty = async (req, res) => {
    try {
        await assertAssetController(req);

        const { ownerEmployeeId, triggerAssetId } = req.body;
        if (!ownerEmployeeId || !mongoose.Types.ObjectId.isValid(String(ownerEmployeeId))) {
            return res.status(400).json({ message: 'Valid ownerEmployeeId is required.' });
        }

        const owner = await EmployeeBasic.findById(ownerEmployeeId)
            .select('firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee')
            .lean();
        if (!owner) return res.status(404).json({ message: 'Owner employee not found.' });

        const parkingAssets = await findParkingAssetsForOwner(owner._id);
        if (!parkingAssets.length) {
            return res.status(400).json({ message: 'This employee has no assets on leave (parking).' });
        }

        const parkingAssetIds = parkingAssets.map((a) => a._id.toString());
        const requesterName =
            req.user?.name ||
            `${req.user?.firstName || ''} ${req.user?.lastName || ''}`.trim() ||
            'Asset Controller';

        const extra3 = JSON.stringify({
            ownerOnDutyReq: true,
            ownerEmployeeId: owner._id.toString(),
            triggerAssetId: triggerAssetId || null,
            parkingAssetIds,
        });

        let dashboardAction = await DashboardAction.findOne({
            assignedTo: owner._id,
            requestType: OWNER_ON_DUTY_REQUEST_TYPE,
            status: 'Pending',
        });

        if (dashboardAction) {
            dashboardAction.extra3 = extra3;
            dashboardAction.extra1 = `On duty review — ${parkingAssets.length} parked asset(s)`;
            dashboardAction.extra2 = 'Owner confirmation required';
            dashboardAction.requestedByName = requesterName;
            dashboardAction.requestedDate = new Date();
            await dashboardAction.save();
        } else {
            dashboardAction = await DashboardAction.create({
                assignedTo: owner._id,
                assignedToEmpId: owner.employeeId,
                requestId: owner._id,
                requestType: OWNER_ON_DUTY_REQUEST_TYPE,
                status: 'Pending',
                subjectEmployeeId: owner.employeeId,
                subjectName: `${owner.firstName || ''} ${owner.lastName || ''}`.trim(),
                requestedByName: requesterName,
                extra1: `On duty review — ${parkingAssets.length} parked asset(s)`,
                extra2: 'Owner confirmation required',
                extra3,
            });
        }

        const reviewUrl = `${resolveFrontendBaseUrl()}/HRM/Asset?ownerOnDutyReview=${dashboardAction._id}`;
        await sendOwnerOnDutyRequestEmail({
            owner,
            requesterName,
            parkingAssets,
            reviewUrl,
        });

        res.status(200).json({
            message: 'On duty confirmation request sent to asset owner.',
            dashboardActionId: dashboardAction._id,
            parkingAssetIds,
            owner: { _id: owner._id, employeeId: owner.employeeId, name: dashboardAction.subjectName },
        });
    } catch (error) {
        console.error('requestOwnerOnDuty:', error);
        res.status(error.status || 500).json({ message: error.message || 'Server error' });
    }
};

/**
 * @route GET /api/AssetItem/owner-on-duty/review/:dashboardActionId
 */
export const getOwnerOnDutyReview = async (req, res) => {
    try {
        const { dashboardActionId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(dashboardActionId)) {
            return res.status(400).json({ message: 'Invalid request id.' });
        }

        const da = await DashboardAction.findById(dashboardActionId).lean();
        if (!da || da.requestType !== OWNER_ON_DUTY_REQUEST_TYPE) {
            return res.status(404).json({ message: 'On duty review request not found.' });
        }
        if (da.status !== 'Pending') {
            return res.status(400).json({ message: 'This on duty request is no longer pending.', status: da.status });
        }

        await assertOwnerOrDelegate(req, da.assignedTo);

        let meta = {};
        try {
            meta = typeof da.extra3 === 'string' ? JSON.parse(da.extra3) : da.extra3 || {};
        } catch {
            meta = {};
        }

        const ownerId = meta.ownerEmployeeId || da.assignedTo;
        const parkingAssets = await findParkingAssetsForOwner(ownerId);

        res.status(200).json({
            dashboardActionId: da._id,
            requestedByName: da.requestedByName,
            owner: {
                _id: ownerId,
                employeeId: da.subjectEmployeeId,
                name: da.subjectName,
            },
            assets: parkingAssets,
            triggerAssetId: meta.triggerAssetId || null,
        });
    } catch (error) {
        console.error('getOwnerOnDutyReview:', error);
        res.status(error.status || 500).json({ message: error.message || 'Server error' });
    }
};

/**
 * @route PUT /api/AssetItem/owner-on-duty/respond
 * Body: { dashboardActionId, cancelled?, decisions: [{ assetId, accept, reason? }] }
 */
export const respondOwnerOnDuty = async (req, res) => {
    try {
        const { dashboardActionId, cancelled, decisions } = req.body;
        if (!dashboardActionId || !mongoose.Types.ObjectId.isValid(String(dashboardActionId))) {
            return res.status(400).json({ message: 'dashboardActionId is required.' });
        }

        const da = await DashboardAction.findById(dashboardActionId);
        if (!da || da.requestType !== OWNER_ON_DUTY_REQUEST_TYPE) {
            return res.status(404).json({ message: 'On duty review request not found.' });
        }
        if (da.status !== 'Pending') {
            return res.status(400).json({ message: 'This request was already completed.' });
        }

        await assertOwnerOrDelegate(req, da.assignedTo);

        if (cancelled) {
            da.status = 'Rejected';
            da.actionedDate = new Date();
            da.actionedBy = req.user?.employeeObjectId || null;
            da.comment = 'Cancelled by owner';
            await da.save();
            return res.status(200).json({ message: 'On duty review cancelled.', cancelled: true });
        }

        if (!Array.isArray(decisions) || decisions.length === 0) {
            return res.status(400).json({ message: 'decisions array is required.' });
        }

        const parkingAssets = await findParkingAssetsForOwner(da.assignedTo);
        const parkingIdSet = new Set(parkingAssets.map((a) => a._id.toString()));
        const decisionMap = new Map(decisions.map((d) => [String(d.assetId), d]));

        for (const id of parkingIdSet) {
            if (!decisionMap.has(id)) {
                return res.status(400).json({ message: 'Please provide a decision for every parked asset.' });
            }
        }

        const accepted = [];
        const declined = [];
        const performedBy = req.user?.employeeObjectId || req.user?._id;

        for (const assetMeta of parkingAssets) {
            const id = assetMeta._id.toString();
            const decision = decisionMap.get(id);
            const accept = decision?.accept === true;

            if (accept) {
                const item = await AssetItem.findById(id);
                if (!item || !isParkingStatus(item.status)) continue;
                await applyOnDutyToAsset(item, performedBy);
                accepted.push({ assetId: item.assetId, name: item.name, _id: item._id });
            } else {
                const reason = String(decision?.reason || '').trim();
                if (!reason) {
                    return res.status(400).json({
                        message: `Reason is required for assets not taken on duty (${assetMeta.assetId}).`,
                    });
                }
                await AssetHistory.create({
                    assetId: assetMeta._id,
                    action: 'Comment',
                    assignedTo: da.assignedTo,
                    performedBy,
                    comments: `Owner declined on duty. Asset remains on leave. Reason: ${reason}`,
                    date: new Date(),
                    details: { ownerOnDutyDeclined: true, reason },
                });
                declined.push({ assetId: assetMeta.assetId, name: assetMeta.name, reason, _id: assetMeta._id });
            }
        }

        let outcomeLabel = 'None accepted';
        if (accepted.length && !declined.length) outcomeLabel = 'All accepted';
        else if (accepted.length && declined.length) outcomeLabel = 'Partial';
        else if (!accepted.length && declined.length) outcomeLabel = 'None accepted';

        da.status = 'Approved';
        da.actionedDate = new Date();
        da.actionedBy = performedBy;
        da.comment = outcomeLabel;
        await da.save();

        const owner = await EmployeeBasic.findById(da.assignedTo).lean();
        const assetController = await getDepartmentHOD('assetcontroller');
        if (assetController) {
            await sendOwnerOnDutyResponseEmail({
                assetController,
                owner,
                accepted,
                declined,
                outcomeLabel,
            });
        }

        res.status(200).json({
            message: 'On duty review submitted.',
            outcome: outcomeLabel,
            accepted,
            declined,
        });
    } catch (error) {
        console.error('respondOwnerOnDuty:', error);
        res.status(error.status || 500).json({ message: error.message || 'Server error' });
    }
};

export { OWNER_ON_DUTY_REQUEST_TYPE };
