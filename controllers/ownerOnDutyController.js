import mongoose from 'mongoose';
import AssetItem from '../models/AssetItem.js';
import AssetHistory from '../models/AssetHistory.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import DashboardAction from '../models/DashboardAction.js';
import { getDepartmentHOD, isUserInFlowchart } from '../utils/getDepartmentHOD.js';
import { sendOwnerOnDutyRequestEmail } from '../utils/sendOwnerOnDutyRequestEmail.js';
import { sendOwnerOnDutyResponseEmail } from '../utils/sendOwnerOnDutyResponseEmail.js';
import { sendOwnerOnDutyAcRequestEmail } from '../utils/sendOwnerOnDutyAcRequestEmail.js';
import { sendOwnerOnDutyAcDecisionEmail } from '../utils/sendOwnerOnDutyAcDecisionEmail.js';
import { sendAssetControllerOnDutyEmail } from '../utils/sendAssetControllerOnDutyEmail.js';
import { resolveAssetControllerEmployee } from '../utils/assetApprovalHelpers.js';
import { resolveFrontendBaseUrl } from '../utils/resolveFrontendBaseUrl.js';
import { applyOnDutyFromLeaveState, healStaleParkingFields, isLeaveActive, onLeaveQueryFilter, requiresOwnerOnDutyApproval } from '../utils/assetOperationalFlags.js';
import { completeOperationalExpiryDashboardTasks } from '../utils/upsertOperationalExpiryDashboardTask.js';
import { isJwtSystemSuperUser } from '../utils/systemSuperUser.js';

const OWNER_ON_DUTY_REQUEST_TYPE = 'Asset Owner On Duty';
const OWNER_ON_DUTY_AC_REQUEST_TYPE = 'Asset On Duty Request';

const applyOnDutyToAsset = async (item, performedBy) => {
    const prevAssignedTo = item.assignedTo?._id || item.assignedTo;
    const snapshot = item.toObject();

    const result = applyOnDutyFromLeaveState(item);
    if (!result.ok) {
        throw new Error(`Asset ${item.assetId} has no assignee`);
    }

    await item.save();

    const ownerAfterDuty = item.assignedTo?._id || item.assignedTo;
    if (ownerAfterDuty) {
        await refreshStaleOwnerOnDutyDashboardForOwner(ownerAfterDuty).catch(() => null);
    }

    await completeOperationalExpiryDashboardTasks(item._id, ['leave']);

    await AssetHistory.create({
        assetId: item._id,
        action: 'Assigned',
        assignedTo: prevAssignedTo,
        performedBy,
        comments: `Asset returned from leave and set On Duty by owner confirmation${result.originalDuration ? ` (duration tracking: ${result.originalDuration} day(s))` : ''}. On service status unchanged.`,
        date: new Date(),
        details: {
            previousStatus: snapshot.status,
            duration: result.originalDuration,
            ownerOnDutyConfirm: true,
            onDutyPath: 'leave',
        },
    });
};

const resolveOwnerEmployee = async (rawId) => {
    const s = String(rawId ?? '').trim();
    if (!s) return null;
    if (mongoose.Types.ObjectId.isValid(s)) {
        const byOid = await EmployeeBasic.findById(s)
            .select('firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee')
            .lean();
        if (byOid) return byOid;
    }
    const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return EmployeeBasic.findOne({
        employeeId: { $regex: new RegExp(`^${escaped}$`, 'i') },
    })
        .select('firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee')
        .lean();
};

const assignedToId = (asset) => String(asset?.assignedTo?._id || asset?.assignedTo || '');

const findParkingAssetsForOwner = async (ownerId) => {
    const oid = mongoose.Types.ObjectId.isValid(String(ownerId))
        ? new mongoose.Types.ObjectId(String(ownerId))
        : null;
    if (!oid) return [];

    const rows = await AssetItem.find({
        assignedTo: oid,
        ...onLeaveQueryFilter(),
    })
        .select(
            'assetId name status onLeaveActive onServiceActive assignedTo assignedToType onLeaveEndDate onLeaveStartDate onLeaveDuration services',
        )
        .sort({ assetId: 1 })
        .lean();

    return rows.filter((asset) => asset.assignedToType !== 'Company' && isLeaveActive(asset));
};

const parseOwnerOnDutyMeta = (extra3) => {
    try {
        return typeof extra3 === 'string' ? JSON.parse(extra3) : extra3 || {};
    } catch {
        return {};
    }
};

const resolveScopedParkingAssets = async (ownerId, requestedAssetIds = null) => {
    const ownerKey = String(ownerId || '');
    if (Array.isArray(requestedAssetIds) && requestedAssetIds.length) {
        const valid = requestedAssetIds.filter((id) => mongoose.Types.ObjectId.isValid(String(id)));
        if (!valid.length) return [];
        const rows = await AssetItem.find({ _id: { $in: valid } })
            .select(
                'assetId name status onLeaveActive onServiceActive assignedTo assignedToType onLeaveEndDate onLeaveStartDate onLeaveDuration services',
            )
            .lean();
        return rows.filter(
            (asset) =>
                asset.assignedToType !== 'Company' &&
                isLeaveActive(asset) &&
                assignedToId(asset) === ownerKey,
        );
    }
    return findParkingAssetsForOwner(ownerId);
};

/** Live parked assets still covered by a pending owner on-duty dashboard row. */
export const resolveOwnerOnDutyParkingAssetsForDashboard = async (da) => {
    if (!da) return [];
    const meta = parseOwnerOnDutyMeta(da.extra3);
    const ownerId = meta.ownerEmployeeId || da.assignedTo || da.requestId;
    const scopedIds = meta.requestedAssetIds || meta.parkingAssetIds;
    return resolveScopedParkingAssets(ownerId, scopedIds);
};

/** Close owner on-duty bell row when assets are no longer on leave (stale notification). */
export const closeStaleOwnerOnDutyDashboardAction = async (
    dashboardActionId,
    comment = 'Auto-closed: no parked assets remain.',
) => {
    if (!dashboardActionId) return;
    await DashboardAction.findOneAndUpdate(
        { _id: dashboardActionId, status: 'Pending', requestType: OWNER_ON_DUTY_REQUEST_TYPE },
        {
            $set: {
                status: 'Approved',
                actionedDate: new Date(),
                comment,
            },
        },
    );
};

/** Close pending owner on-duty bells for an owner when parking is fully resolved elsewhere. */
export const refreshStaleOwnerOnDutyDashboardForOwner = async (ownerId) => {
    const oidStr = String(ownerId ?? '').trim();
    if (!mongoose.Types.ObjectId.isValid(oidStr)) return;
    const oid = new mongoose.Types.ObjectId(oidStr);

    const pendingRows = await DashboardAction.find({
        assignedTo: oid,
        requestType: OWNER_ON_DUTY_REQUEST_TYPE,
        status: 'Pending',
    })
        .select('_id extra3')
        .lean();

    for (const da of pendingRows) {
        const parking = await resolveOwnerOnDutyParkingAssetsForDashboard(da);
        if (!parking.length) {
            await closeStaleOwnerOnDutyDashboardAction(da._id);
        }
    }
};

const applyDirectOnDutyFromLeave = async (item, performedBy) => {
    const prevAssignedTo = item.assignedTo?._id || item.assignedTo;
    const dutyResult = applyOnDutyFromLeaveState(item);
    await item.save();
    if (prevAssignedTo) {
        await refreshStaleOwnerOnDutyDashboardForOwner(prevAssignedTo).catch(() => null);
    }
    await completeOperationalExpiryDashboardTasks(item._id, ['leave']);
    await AssetHistory.create({
        assetId: item._id,
        action: 'Assigned',
        assignedTo: prevAssignedTo || undefined,
        performedBy,
        comments: dutyResult.directUnassigned
            ? 'Asset cleared from On Leave by Asset Controller (unassigned).'
            : `Asset returned from leave and set On Duty by Asset Controller${dutyResult.originalDuration ? ` (duration tracking: ${dutyResult.originalDuration} day(s))` : ''}. On service status unchanged.`,
        date: new Date(),
        details: {
            duration: dutyResult.originalDuration,
            onDutyPath: 'leave',
            directByAssetController: true,
            directUnassigned: !!dutyResult.directUnassigned,
        },
    });
    return dutyResult;
};

const closePendingOnDutyRequestsForAssets = async (assetIds, performedBy) => {
    const ids = (assetIds || []).filter((id) => mongoose.Types.ObjectId.isValid(String(id)));
    if (!ids.length) return;
    await DashboardAction.updateMany(
        {
            status: 'Pending',
            requestType: { $in: [OWNER_ON_DUTY_AC_REQUEST_TYPE, OWNER_ON_DUTY_REQUEST_TYPE] },
            $or: [{ requestId: { $in: ids } }],
        },
        {
            $set: {
                status: 'Approved',
                actionedDate: new Date(),
                actionedBy: performedBy || null,
                comment: 'Applied directly by Asset Controller',
            },
        },
    );
};

/**
 * @route POST /api/AssetItem/owner-on-duty/apply-direct
 * Asset Controller sets parked asset(s) On Duty immediately (no owner confirmation).
 */
export const applyOnDutyDirectByController = async (req, res) => {
    try {
        await assertAssetController(req);

        const rawIds = Array.isArray(req.body?.assetIds) ? req.body.assetIds : [];
        const triggerAssetId = req.body?.triggerAssetId;
        const assetIds = [...new Set(
            [...rawIds, triggerAssetId]
                .map((x) => String(x || '').trim())
                .filter((id) => mongoose.Types.ObjectId.isValid(id)),
        )];
        if (!assetIds.length) {
            return res.status(400).json({ message: 'triggerAssetId or assetIds is required.' });
        }

        const items = await AssetItem.find({ _id: { $in: assetIds } });
        const performedBy = req.user?.employeeObjectId || req.user?._id;
        const processed = [];
        let ownerId = null;

        for (const item of items) {
            if (!item || !isLeaveActive(item)) continue;
            if (!ownerId) ownerId = assignedToId(item) || null;
            await applyDirectOnDutyFromLeave(item, performedBy);
            processed.push({ _id: item._id, assetId: item.assetId, name: item.name });
        }

        if (!processed.length) {
            return res.status(400).json({ message: 'No on-leave assets to set On Duty.' });
        }

        await closePendingOnDutyRequestsForAssets(
            processed.map((p) => p._id),
            performedBy,
        );

        const owner = ownerId
            ? await EmployeeBasic.findById(ownerId)
                .select('firstName lastName employeeId companyEmail primaryReportee status profileStatus')
                .populate('primaryReportee', 'firstName lastName employeeId companyEmail status profileStatus')
                .lean()
            : null;
        const approver = await EmployeeBasic.findById(req.user?.employeeObjectId)
            .select('firstName lastName employeeId')
            .lean();

        if (owner) {
            await sendAssetControllerOnDutyEmail({
                owner,
                parkingAssets: processed,
                approver,
            });
        }

        res.status(200).json({
            message: processed.length === 1
                ? 'Asset is now On Duty.'
                : `${processed.length} assets are now On Duty.`,
            processed,
        });
    } catch (error) {
        console.error('applyOnDutyDirectByController:', error);
        res.status(error.status || 500).json({ message: error.message || 'Server error' });
    }
};

const createOwnerOnDutyRequest = async ({ req, owner, requestedAssetIds = null, triggerAssetId = null }) => {
    let parkingAssets = await resolveScopedParkingAssets(owner._id, requestedAssetIds);
    if (
        !parkingAssets.length &&
        triggerAssetId &&
        mongoose.Types.ObjectId.isValid(String(triggerAssetId))
    ) {
        const trigger = await AssetItem.findById(triggerAssetId).lean();
        if (
            trigger &&
            isLeaveActive(trigger) &&
            trigger.assignedToType !== 'Company' &&
            assignedToId(trigger) === String(owner._id)
        ) {
            parkingAssets = [trigger];
        }
    }
    if (!parkingAssets.length) {
        return { ok: false, message: 'No matching on-leave assets found for this owner.' };
    }

    const parkingAssetIds = parkingAssets.map((a) => a._id.toString());
    const requesterName =
        req.user?.name ||
        `${req.user?.firstName || ''} ${req.user?.lastName || ''}`.trim() ||
        'Asset Controller';

    const extra3 = JSON.stringify({
        ownerOnDutyReq: true,
        ownerEmployeeId: owner._id.toString(),
        triggerAssetId: triggerAssetId || parkingAssetIds[0] || null,
        parkingAssetIds,
        requestedAssetIds: parkingAssetIds,
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

    return {
        ok: true,
        dashboardActionId: dashboardAction._id,
        parkingAssetIds,
        ownerName: dashboardAction.subjectName,
        assetCount: parkingAssets.length,
    };
};

const assertOwnerAssignee = async (req, ownerId) => {
    const actingId = req.user?.employeeObjectId?.toString?.();
    const ownerIdStr = ownerId?.toString?.();
    if (actingId && ownerIdStr && actingId === ownerIdStr) return true;

    const owner = await EmployeeBasic.findById(ownerId).select('primaryReportee').lean();
    const reporteeId = owner?.primaryReportee?.toString?.() || owner?.primaryReportee?.toString?.();
    if (actingId && reporteeId && actingId === reporteeId) return true;

    const isAdmin = isJwtSystemSuperUser(req.user);
    if (isAdmin) return true;

    const err = new Error('Only the assigned asset owner (or their delegate) can request on duty.');
    err.status = 403;
    throw err;
};

const createOwnerInitiatedOnDutyAcRequest = async ({ req, owner, requestedAssetIds = null, triggerAssetId = null }) => {
    let parkingAssets = await resolveScopedParkingAssets(owner._id, requestedAssetIds);
    if (
        !parkingAssets.length &&
        triggerAssetId &&
        mongoose.Types.ObjectId.isValid(String(triggerAssetId))
    ) {
        const trigger = await AssetItem.findById(triggerAssetId).lean();
        if (
            trigger &&
            isLeaveActive(trigger) &&
            trigger.assignedToType !== 'Company' &&
            assignedToId(trigger) === String(owner._id)
        ) {
            parkingAssets = [trigger];
        }
    }
    if (!parkingAssets.length) {
        return { ok: false, message: 'No matching on-leave assets found for this owner.' };
    }

    const parkingAssetIds = parkingAssets.map((a) => a._id.toString());
    const primaryAssetId = triggerAssetId || parkingAssetIds[0];

    const existing = await DashboardAction.findOne({
        requestId: primaryAssetId,
        requestType: OWNER_ON_DUTY_AC_REQUEST_TYPE,
        status: 'Pending',
    }).lean();
    if (existing) {
        return {
            ok: true,
            alreadyPending: true,
            dashboardActionId: existing._id,
            parkingAssetIds,
            ownerName: `${owner.firstName || ''} ${owner.lastName || ''}`.trim(),
            assetCount: parkingAssets.length,
        };
    }

    const acRaw = await getDepartmentHOD('assetcontroller');
    const assetController = await resolveAssetControllerEmployee(acRaw);
    if (!assetController?._id) {
        return { ok: false, message: 'Asset Controller is not configured.' };
    }

    const ownerName = `${owner.firstName || ''} ${owner.lastName || ''}`.trim() || owner.employeeId || 'Asset owner';
    const extra3 = JSON.stringify({
        ownerInitiatedOnDuty: true,
        ownerEmployeeId: owner._id.toString(),
        triggerAssetId: primaryAssetId,
        requestedAssetIds: parkingAssetIds,
        parkingAssetIds,
    });

    const dashboardAction = await DashboardAction.create({
        assignedTo: assetController._id,
        assignedToEmpId: assetController.employeeId,
        requestId: primaryAssetId,
        requestType: OWNER_ON_DUTY_AC_REQUEST_TYPE,
        status: 'Pending',
        subjectEmployeeId: owner.employeeId,
        subjectName: ownerName,
        requestedByName: ownerName,
        extra1: `On duty request — ${parkingAssets.map((a) => a.assetId).join(', ')}`,
        extra2: 'Asset Controller approval required',
        extra3,
    });

    const reviewUrl = `${resolveFrontendBaseUrl()}/HRM/Asset/details/${primaryAssetId}`;
    await sendOwnerOnDutyAcRequestEmail({
        assetController,
        owner,
        parkingAssets,
        reviewUrl,
    });

    return {
        ok: true,
        dashboardActionId: dashboardAction._id,
        parkingAssetIds,
        ownerName,
        assetCount: parkingAssets.length,
    };
};

const assertAssetController = async (req) => {
    const isAdmin = isJwtSystemSuperUser(req.user);
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

    const isAdmin = isJwtSystemSuperUser(req.user);
    if (isAdmin) return true;

    const err = new Error('Only the asset owner (or their delegate) can respond to this request.');
    err.status = 403;
    throw err;
};

export const requestOnDutyFromOwner = async (req, res) => {
    try {
        const { triggerAssetId, assetIds } = req.body;
        const requestedAssetIds = Array.isArray(assetIds)
            ? assetIds.map(String).filter(Boolean)
            : triggerAssetId
              ? [String(triggerAssetId)]
              : [];

        let isAc = false;
        try {
            await assertAssetController(req);
            isAc = true;
        } catch {
            isAc = false;
        }

        if (isAc) {
            req.body.assetIds = requestedAssetIds.length ? requestedAssetIds : assetIds;
            if (!req.body.triggerAssetId && requestedAssetIds[0]) {
                req.body.triggerAssetId = requestedAssetIds[0];
            }
            return applyOnDutyDirectByController(req, res);
        }

        const actingId = req.user?.employeeObjectId;
        if (!actingId) {
            return res.status(403).json({ message: 'You are not linked to an employee profile.' });
        }

        const owner = await EmployeeBasic.findById(actingId)
            .select('firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee')
            .lean();
        if (!owner) return res.status(404).json({ message: 'Owner employee not found.' });

        await assertOwnerAssignee(req, owner._id);

        const result = await createOwnerInitiatedOnDutyAcRequest({
            req,
            owner,
            requestedAssetIds: requestedAssetIds.length ? requestedAssetIds : null,
            triggerAssetId,
        });
        if (!result.ok) {
            return res.status(400).json({ message: result.message || 'Could not create on-duty request.' });
        }

        res.status(200).json({
            message: result.alreadyPending
                ? 'On duty request is already pending Asset Controller approval.'
                : 'On duty request sent to Asset Controller for approval.',
            dashboardActionId: result.dashboardActionId,
            parkingAssetIds: result.parkingAssetIds,
            alreadyPending: !!result.alreadyPending,
        });
    } catch (error) {
        console.error('requestOnDutyFromOwner:', error);
        res.status(error.status || 500).json({ message: error.message || 'Server error' });
    }
};

/**
 * @route GET /api/AssetItem/owner-on-duty/status/:ownerId
 * Owner / AC / admin: parked assets + pending On Duty request for this assignee.
 */
export const getOwnerOnDutyStatus = async (req, res) => {
    try {
        const owner = await resolveOwnerEmployee(req.params.ownerId);
        if (!owner) return res.status(404).json({ message: 'Employee not found.' });

        const actingId = req.user?.employeeObjectId?.toString?.();
        const isOwner = !!(actingId && actingId === owner._id.toString());
        const isAdmin = isJwtSystemSuperUser(req.user);
        let isAc = false;
        try {
            await assertAssetController(req);
            isAc = true;
        } catch {
            isAc = false;
        }

        let isDelegate = false;
        if (!isOwner && !isAdmin && !isAc) {
            try {
                await assertOwnerOrDelegate(req, owner._id);
                isDelegate = true;
            } catch {
                isDelegate = false;
            }
        }

        const parkingAssets = await findParkingAssetsForOwner(owner._id);
        const parkingIds = parkingAssets.map((a) => a._id);

        const pendingAc = await DashboardAction.findOne({
            requestType: OWNER_ON_DUTY_AC_REQUEST_TYPE,
            status: 'Pending',
            $or: [
                { subjectEmployeeId: owner.employeeId },
                ...(parkingIds.length ? [{ requestId: { $in: parkingIds } }] : []),
            ],
        })
            .sort({ requestedDate: -1, createdAt: -1 })
            .lean();

        let pendingAcMatch = pendingAc;
        if (pendingAcMatch) {
            const meta = parseOwnerOnDutyMeta(pendingAcMatch.extra3);
            const ownerFromMeta = String(meta.ownerEmployeeId || '');
            const scopedIds = (meta.requestedAssetIds || meta.parkingAssetIds || []).map(String);
            const matchesOwner =
                !ownerFromMeta || ownerFromMeta === owner._id.toString();
            const matchesAsset =
                !scopedIds.length ||
                scopedIds.some((id) => parkingIds.some((pid) => String(pid) === id));
            if (!matchesOwner && !matchesAsset) pendingAcMatch = null;
        }

        const pendingOwnerReview = await DashboardAction.findOne({
            assignedTo: owner._id,
            requestType: OWNER_ON_DUTY_REQUEST_TYPE,
            status: 'Pending',
        })
            .select('_id')
            .lean();

        res.json({
            onLeave: parkingAssets.length > 0,
            parkingAssets: parkingAssets.map((a) => ({
                _id: a._id,
                assetId: a.assetId,
                name: a.name,
            })),
            pendingAcRequestId: pendingAcMatch?._id || null,
            pendingOwnerReviewId: pendingOwnerReview?._id || null,
            canRequest: isOwner,
            canApproveAsAc: isAc || isAdmin,
            canView: isOwner || isDelegate || isAc || isAdmin || parkingAssets.length > 0,
        });
    } catch (error) {
        console.error('getOwnerOnDutyStatus:', error);
        res.status(error.status || 500).json({ message: error.message || 'Server error' });
    }
};

/**
 * @route GET /api/AssetItem/owner-on-duty/pending-owner-request/:assetId
 */
export const getPendingOnDutyRequestFromOwner = async (req, res) => {
    try {
        const { assetId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(String(assetId))) {
            return res.status(400).json({ message: 'Invalid asset id.' });
        }

        const actingId = req.user?.employeeObjectId?.toString?.();
        const da = await DashboardAction.findOne({
            requestId: assetId,
            requestType: OWNER_ON_DUTY_AC_REQUEST_TYPE,
            status: 'Pending',
        }).lean();

        if (!da) {
            return res.json({ pending: false });
        }

        const meta = parseOwnerOnDutyMeta(da.extra3);
        const ownerEmpOid = meta.ownerEmployeeId;
        const isOwner = !!(actingId && ownerEmpOid && actingId === String(ownerEmpOid));

        if (!isOwner) {
            try {
                await assertAssetController(req);
            } catch {
                return res.status(403).json({ message: 'Access denied.' });
            }
        }

        res.json({
            pending: true,
            dashboardActionId: da._id,
            requestedByName: da.requestedByName,
            ownerEmployeeId: ownerEmpOid,
        });
    } catch (error) {
        console.error('getPendingOnDutyRequestFromOwner:', error);
        res.status(error.status || 500).json({ message: error.message || 'Server error' });
    }
};

/**
 * @route PUT /api/AssetItem/owner-on-duty/respond-ac-request
 * Body: { dashboardActionId, approve, comment? }
 */
export const respondOnDutyAcRequest = async (req, res) => {
    try {
        await assertAssetController(req);

        const { dashboardActionId, approve, comment } = req.body;
        if (!dashboardActionId || !mongoose.Types.ObjectId.isValid(String(dashboardActionId))) {
            return res.status(400).json({ message: 'dashboardActionId is required.' });
        }

        const da = await DashboardAction.findById(dashboardActionId);
        if (!da || da.requestType !== OWNER_ON_DUTY_AC_REQUEST_TYPE) {
            return res.status(404).json({ message: 'On duty request not found.' });
        }
        if (da.status !== 'Pending') {
            return res.status(400).json({ message: 'This request was already completed.' });
        }

        const meta = parseOwnerOnDutyMeta(da.extra3);
        const ownerId = meta.ownerEmployeeId || da.assignedTo;
        const owner = await EmployeeBasic.findById(ownerId).lean();
        const scopedIds = meta.requestedAssetIds || meta.parkingAssetIds;
        const parkingAssets = await resolveScopedParkingAssets(ownerId, scopedIds);
        const performedBy = req.user?.employeeObjectId || req.user?._id;
        const approver = await EmployeeBasic.findById(req.user?.employeeObjectId)
            .select('firstName lastName employeeId')
            .lean();

        const processed = [];

        if (approve) {
            for (const assetMeta of parkingAssets) {
                const item = await AssetItem.findById(assetMeta._id);
                if (!item || !isLeaveActive(item)) continue;
                await applyDirectOnDutyFromLeave(item, performedBy);
                processed.push({ _id: item._id, assetId: item.assetId, name: item.name });
            }
            da.status = 'Approved';
            da.comment = comment || 'Approved by Asset Controller';
        } else {
            for (const assetMeta of parkingAssets) {
                await AssetHistory.create({
                    assetId: assetMeta._id,
                    action: 'Comment',
                    assignedTo: ownerId,
                    performedBy,
                    comments: `On duty request rejected by Asset Controller. Asset remains on leave. ${comment || ''}`,
                    date: new Date(),
                    details: { ownerOnDutyAcRejected: true, reason: comment || '' },
                });
            }
            da.status = 'Rejected';
            da.comment = comment || 'Rejected by Asset Controller';
        }

        da.actionedDate = new Date();
        da.actionedBy = req.user?.employeeObjectId || null;
        await da.save();

        if (owner) {
            await sendOwnerOnDutyAcDecisionEmail({
                owner,
                approver,
                approved: !!approve,
                parkingAssets: processed.length ? processed : parkingAssets,
                comment: comment || '',
            });
        }

        if (ownerId) {
            await refreshStaleOwnerOnDutyDashboardForOwner(ownerId).catch(() => null);
        }

        res.status(200).json({
            message: approve ? 'On duty request approved.' : 'On duty request rejected.',
            approved: !!approve,
            processed,
        });
    } catch (error) {
        console.error('respondOnDutyAcRequest:', error);
        res.status(error.status || 500).json({ message: error.message || 'Server error' });
    }
};

/**
 * @route POST /api/AssetItem/owner-on-duty/request
 */
export const requestOwnerOnDuty = async (req, res) => {
    try {
        await assertAssetController(req);

        const { ownerEmployeeId, triggerAssetId, assetIds } = req.body;
        if (!ownerEmployeeId) {
            return res.status(400).json({ message: 'ownerEmployeeId is required.' });
        }

        const owner = await resolveOwnerEmployee(ownerEmployeeId);
        if (!owner) return res.status(404).json({ message: 'Owner employee not found.' });

        const requestedAssetIds = Array.isArray(assetIds)
            ? assetIds.map(String).filter(Boolean)
            : triggerAssetId
              ? [String(triggerAssetId)]
              : null;

        const result = await createOwnerOnDutyRequest({
            req,
            owner,
            requestedAssetIds,
            triggerAssetId,
        });
        if (!result.ok) {
            return res.status(400).json({ message: result.message || 'This employee has no assets on leave (parking).' });
        }

        res.status(200).json({
            message: 'On duty confirmation request sent to asset owner.',
            dashboardActionId: result.dashboardActionId,
            parkingAssetIds: result.parkingAssetIds,
            owner: { _id: owner._id, employeeId: owner.employeeId, name: result.ownerName },
        });
    } catch (error) {
        console.error('requestOwnerOnDuty:', error);
        res.status(error.status || 500).json({ message: error.message || 'Server error' });
    }
};

/**
 * @route PUT /api/AssetItem/bulk/on-duty-from-leave
 * Assigned employee assets → owner email + dashboard task. Unassigned / company → direct On Duty.
 */
export const bulkOnDutyFromLeave = async (req, res) => {
    try {
        await assertAssetController(req);

        const rawIds = Array.isArray(req.body?.assetIds) ? req.body.assetIds : [];
        const assetIds = [...new Set(rawIds.map((x) => String(x).trim()).filter(Boolean))];
        if (!assetIds.length) {
            return res.status(400).json({ message: 'Please provide at least one asset ID.' });
        }

        const validIds = assetIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
        if (!validIds.length) {
            return res.status(400).json({ message: 'No valid asset IDs provided.' });
        }

        const items = await AssetItem.find({ _id: { $in: validIds } })
            .select('assetId name assignedTo assignedToType assignedCompany onLeaveActive status')
            .lean();

        const byId = new Map(items.map((a) => [a._id.toString(), a]));
        const directIds = [];
        const ownerGroups = new Map();
        const skipped = [];

        for (const id of validIds) {
            const item = byId.get(id);
            if (!item) {
                skipped.push({ assetId: id, reason: 'Asset not found' });
                continue;
            }
            if (!isLeaveActive(item)) {
                skipped.push({ assetId: item.assetId || id, reason: 'Asset is not on leave' });
                continue;
            }
            if (requiresOwnerOnDutyApproval(item)) {
                const ownerKey = String(item.assignedTo?._id || item.assignedTo);
                if (!ownerGroups.has(ownerKey)) ownerGroups.set(ownerKey, []);
                ownerGroups.get(ownerKey).push(id);
            } else {
                directIds.push(id);
            }
        }

        const performedBy = req.user?.employeeObjectId || req.user?._id;
        const directProcessed = [];

        for (const id of directIds) {
            const doc = await AssetItem.findById(id);
            if (!doc || !isLeaveActive(doc)) continue;
            await applyDirectOnDutyFromLeave(doc, performedBy);
            directProcessed.push({ _id: doc._id, assetId: doc.assetId, name: doc.name });
        }

        const ownerRequests = [];
        for (const [ownerKey, ids] of ownerGroups) {
            const owner = await resolveOwnerEmployee(ownerKey);
            if (!owner) {
                for (const id of ids) {
                    const meta = byId.get(id);
                    skipped.push({ assetId: meta?.assetId || id, reason: 'Assignee employee not found' });
                }
                continue;
            }
            const result = await createOwnerOnDutyRequest({
                req,
                owner,
                requestedAssetIds: ids,
                triggerAssetId: ids[0],
            });
            if (!result.ok) {
                for (const id of ids) {
                    const meta = byId.get(id);
                    skipped.push({ assetId: meta?.assetId || id, reason: result.message || 'Owner request failed' });
                }
                continue;
            }
            ownerRequests.push({
                ownerId: owner._id,
                ownerName: result.ownerName,
                assetCount: result.assetCount,
                dashboardActionId: result.dashboardActionId,
                assetIds: result.parkingAssetIds,
            });
        }

        if (!directProcessed.length && !ownerRequests.length) {
            return res.status(400).json({
                message: 'No assets could be processed for On Duty.',
                skipped,
            });
        }

        const parts = [];
        if (directProcessed.length) {
            parts.push(`${directProcessed.length} unassigned asset(s) set On Duty immediately`);
        }
        if (ownerRequests.length) {
            parts.push(
                `owner confirmation sent for ${ownerRequests.reduce((n, r) => n + r.assetCount, 0)} assigned asset(s)`,
            );
        }

        res.status(200).json({
            message: parts.join('; ') + '.',
            directProcessed,
            ownerRequests,
            skipped: skipped.length ? skipped : undefined,
        });
    } catch (error) {
        console.error('bulkOnDutyFromLeave:', error);
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

        let meta = parseOwnerOnDutyMeta(da.extra3);

        const ownerId = meta.ownerEmployeeId || da.assignedTo;
        const scopedIds = meta.requestedAssetIds || meta.parkingAssetIds;
        const parkingAssets = await resolveScopedParkingAssets(ownerId, scopedIds);

        if (!parkingAssets.length) {
            await closeStaleOwnerOnDutyDashboardAction(da._id);
            return res.status(404).json({ message: 'No parked assets found for this request.' });
        }

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

        const meta = parseOwnerOnDutyMeta(da.extra3);
        const scopedIds = meta.requestedAssetIds || meta.parkingAssetIds;
        const parkingAssets = await resolveScopedParkingAssets(da.assignedTo, scopedIds);
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
                if (!item) continue;

                if (isLeaveActive(item)) {
                    await applyOnDutyToAsset(item, performedBy);
                    accepted.push({ assetId: item.assetId, name: item.name, _id: item._id });
                } else if (healStaleParkingFields(item)) {
                    await item.save();
                    await AssetHistory.create({
                        assetId: item._id,
                        action: 'Assigned',
                        assignedTo: item.assignedTo,
                        performedBy,
                        comments: 'Stale parking fields cleared after on duty confirmation (asset was already off leave).',
                        date: new Date(),
                        details: { ownerOnDutyConfirm: true, healedStaleParking: true },
                    });
                    accepted.push({ assetId: item.assetId, name: item.name, _id: item._id });
                } else {
                    accepted.push({ assetId: item.assetId, name: item.name, _id: item._id });
                }
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

export { OWNER_ON_DUTY_REQUEST_TYPE, OWNER_ON_DUTY_AC_REQUEST_TYPE };
