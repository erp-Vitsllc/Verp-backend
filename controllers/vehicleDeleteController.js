import AssetItem from '../models/AssetItem.js';
import AssetHistory from '../models/AssetHistory.js';
import { getDepartmentHOD, isUserInFlowchart } from '../utils/getDepartmentHOD.js';
import { resolveFrontendBaseUrl } from '../utils/resolveFrontendBaseUrl.js';
import { syncDashboardAction } from '../utils/syncDashboard.js';
import { resolveProfileActivationSubmitterId } from '../utils/resolveProfileActivationSubmitterId.js';
import {
    isFleetVehicleAsset,
    isFleetVehicleProfileActive,
} from '../utils/assetApprovalHelpers.js';
import { hasPermission, isUserAdministrator } from '../services/permissionService.js';
import { cleanupDashboardActionsForDeletedAsset } from '../utils/cleanupAssetDashboardActions.js';
import {
    notifyAdminDeletedWholeAsset,
    getAssetControllerNotificationEmail,
} from '../utils/sendAdminDeletionNotificationEmails.js';

const vehicleSubjectForDashboard = (asset) => ({
    firstName: asset.name || 'Vehicle',
    lastName: `(${asset.assetId || ''})`.trim(),
    employeeId: asset.assetId || '',
    designation: asset.typeId?.name || '',
});

async function isReqAdmin(user) {
    if (!user) return false;
    if (user.isAdministrator || user.role === 'admin') return true;
    const uid = user.id || user._id;
    if (!uid) return false;
    return isUserAdministrator(uid);
}

async function isReqHr(user) {
    if (!user) return false;
    if (await isUserInFlowchart(user, 'hr')) return true;
    const hod = await getDepartmentHOD('hr');
    if (!hod) return false;
    if (hod._id && user.employeeObjectId && String(hod._id) === String(user.employeeObjectId)) return true;
    const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
    if (hod.employeeId && user.employeeId && norm(hod.employeeId) === norm(user.employeeId)) return true;
    return false;
}

async function isReqAssetController(user) {
    if (!user) return false;
    if (await isUserInFlowchart(user, 'assetcontroller')) return true;
    const hod = await getDepartmentHOD('assetcontroller');
    if (!hod) return false;
    if (hod._id && user.employeeObjectId && String(hod._id) === String(user.employeeObjectId)) return true;
    const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
    if (hod.employeeId && user.employeeId && norm(hod.employeeId) === norm(user.employeeId)) return true;
    return false;
}

async function userHasVehicleDeletePermission(user) {
    if (!user) return false;
    if (await isReqAdmin(user)) return true;
    const uid = user.id || user._id;
    if (!uid) return false;
    if (await hasPermission(uid, 'hrm_asset_vehicle_add', 'delete')) return true;
    if (await hasPermission(uid, 'hrm_asset_vehicle', 'delete')) return true;
    return false;
}

export async function canHardDeleteFleetVehicle(req, asset) {
    const admin = await isReqAdmin(req.user);
    const hr = await isReqHr(req.user);
    const ac = await isReqAssetController(req.user);
    const hasDelete = await userHasVehicleDeletePermission(req.user);
    const profileActive = isFleetVehicleProfileActive(asset);

    if (!isFleetVehicleAsset(asset)) {
        return { ok: admin, reason: 'not_fleet' };
    }

    if (!profileActive) {
        if (admin || ac || hasDelete) return { ok: true, mode: 'inactive_direct' };
        return { ok: false, reason: 'no_delete_permission' };
    }

    if (admin || hr) return { ok: true, mode: 'active_hr_or_admin' };
    if (hasDelete) return { ok: false, reason: 'needs_hr_approval' };
    return { ok: false, reason: 'no_delete_permission' };
}

async function performVehicleHardDelete(req, asset) {
    const {
        shouldBlockAssetDeleteBecauseOfAccessories,
        accessoryDeleteBlockMessage,
    } = await import('../utils/assetDeleteAccessoriesRule.js');

    const isAdminUser = await isReqAdmin(req.user);
    if (shouldBlockAssetDeleteBecauseOfAccessories(asset, { isAdmin: isAdminUser })) {
        const err = new Error(accessoryDeleteBlockMessage(asset));
        err.statusCode = 400;
        err.accessoriesCount = asset.accessories?.length || 0;
        throw err;
    }

    let adminNotificationEmail = null;
    if (isAdminUser) {
        adminNotificationEmail = await getAssetControllerNotificationEmail();
        const itemForEmail = await AssetItem.findById(asset._id)
            .populate({
                path: 'assignedTo',
                select: 'firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee',
                populate: {
                    path: 'primaryReportee',
                    select: 'firstName lastName companyEmail workEmail personalEmail email',
                },
            })
            .populate('assignedCompany', 'name companyId')
            .lean();
        if (itemForEmail) {
            await notifyAdminDeletedWholeAsset(req, itemForEmail);
        }
    }

    await cleanupDashboardActionsForDeletedAsset(asset._id);
    await AssetHistory.deleteMany({ assetId: asset._id });
    const typeId = asset.typeId;
    await AssetItem.findByIdAndDelete(asset._id);

    if (typeId) {
        try {
            const AssetType = (await import('../models/AssetType.js')).default;
            const total = await AssetItem.countDocuments({ typeId });
            const assigned = await AssetItem.countDocuments({ typeId, status: 'Assigned' });
            const pending = await AssetItem.countDocuments({ typeId, status: 'Pending' });
            const unassigned = total - assigned - pending;
            await AssetType.findByIdAndUpdate(typeId, { total, assigned, unassigned });
        } catch {
            /* non-fatal */
        }
    }

    return {
        message: 'Asset deleted successfully',
        ...(adminNotificationEmail ? { assetControllerEmail: adminNotificationEmail } : {}),
    };
}

/**
 * POST /api/AssetItem/:id/request-vehicle-delete
 * Inactive: not used (use DELETE). Active: queues HR approval (or hard-deletes if caller is HR/admin).
 */
export const requestVehicleDelete = async (req, res) => {
    try {
        const { id } = req.params;
        const asset = await AssetItem.findById(id).populate('typeId', 'name');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        if (!isFleetVehicleAsset(asset)) {
            return res.status(400).json({ message: 'Only fleet vehicles use this delete request flow.' });
        }

        const hasDelete = await userHasVehicleDeletePermission(req.user);
        if (!hasDelete) {
            return res.status(403).json({ message: 'You do not have permission to delete vehicles.' });
        }

        if (!isFleetVehicleProfileActive(asset)) {
            return res.status(400).json({
                message: 'Inactive vehicles can be deleted directly — no HR approval required.',
                useDirectDelete: true,
            });
        }

        const gate = await canHardDeleteFleetVehicle(req, asset);
        if (gate.ok) {
            const result = await performVehicleHardDelete(req, asset);
            return res.status(200).json({ ...result, deleted: true });
        }

        if (String(asset.vehicleDeleteStatus || '').toLowerCase() === 'pending_hr') {
            return res.status(400).json({ message: 'A delete request is already awaiting HR approval.' });
        }

        const designatedHr = await getDepartmentHOD('hr');
        if (!designatedHr?._id) {
            return res.status(400).json({ message: 'No HR is configured in the flowchart to approve vehicle deletes.' });
        }

        const submitterId = await resolveProfileActivationSubmitterId(req);
        asset.vehicleDeleteStatus = 'pending_hr';
        asset.vehicleDeleteSubmittedAt = new Date();
        asset.vehicleDeleteSubmittedBy = submitterId || null;
        asset.actionRequiredBy = designatedHr._id;
        await asset.save();

        const vehicleLabel = `${asset.name || 'Vehicle'} (${asset.assetId || id})`;
        const detailUrl = `${resolveFrontendBaseUrl(req)}/HRM/Asset/Vehicle/details/${id}?tab=basic&vehicleDeleteReview=1`;
        const requestedByName =
            req.user?.name ||
            [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ').trim() ||
            req.user?.employeeId ||
            '';

        await syncDashboardAction({
            requestId: asset._id,
            requestType: 'Vehicle Delete Request',
            assignedTo: String(designatedHr._id),
            status: 'Pending',
            subjectEmployee: vehicleSubjectForDashboard(asset),
            requestedByName,
            extra1: `[Fleet] ${vehicleLabel} — delete request`,
            extra2: '',
            extra3: JSON.stringify({
                activationSubject: 'vehicle',
                activationViewerRole: 'flowchart_hr',
                vehicleMongoId: String(asset._id),
                vehicleDeleteReview: true,
            }),
        });

        return res.status(200).json({
            message: 'Delete request submitted. HR approval is required for active vehicles.',
            vehicleDeleteStatus: 'pending_hr',
            detailUrl,
            queued: true,
        });
    } catch (err) {
        console.error('requestVehicleDelete:', err);
        return res.status(err.statusCode || 500).json({
            message: err.message || 'Failed to submit vehicle delete request.',
            ...(err.accessoriesCount != null ? { accessoriesCount: err.accessoriesCount } : {}),
        });
    }
};

/**
 * POST /api/AssetItem/:id/approve-vehicle-delete
 */
export const approveVehicleDelete = async (req, res) => {
    try {
        const { id } = req.params;
        if (!(await isReqHr(req.user)) && !(await isReqAdmin(req.user))) {
            return res.status(403).json({ message: 'Only HR or Admin can approve vehicle delete requests.' });
        }

        const asset = await AssetItem.findById(id).populate('typeId', 'name');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });
        if (String(asset.vehicleDeleteStatus || '').toLowerCase() !== 'pending_hr') {
            return res.status(400).json({ message: 'No pending vehicle delete request to approve.' });
        }

        const result = await performVehicleHardDelete(req, asset);
        return res.status(200).json({ ...result, approved: true });
    } catch (err) {
        console.error('approveVehicleDelete:', err);
        return res.status(err.statusCode || 500).json({
            message: err.message || 'Failed to approve vehicle delete.',
            ...(err.accessoriesCount != null ? { accessoriesCount: err.accessoriesCount } : {}),
        });
    }
};

/**
 * POST /api/AssetItem/:id/reject-vehicle-delete
 */
export const rejectVehicleDelete = async (req, res) => {
    try {
        const { id } = req.params;
        if (!(await isReqHr(req.user)) && !(await isReqAdmin(req.user))) {
            return res.status(403).json({ message: 'Only HR or Admin can reject vehicle delete requests.' });
        }

        const asset = await AssetItem.findById(id);
        if (!asset) return res.status(404).json({ message: 'Asset not found' });
        if (String(asset.vehicleDeleteStatus || '').toLowerCase() !== 'pending_hr') {
            return res.status(400).json({ message: 'No pending vehicle delete request to reject.' });
        }

        asset.vehicleDeleteStatus = 'none';
        asset.vehicleDeleteSubmittedAt = null;
        asset.vehicleDeleteSubmittedBy = null;
        asset.actionRequiredBy = null;
        await asset.save();

        await syncDashboardAction({
            requestId: asset._id,
            requestType: 'Vehicle Delete Request',
            status: 'Rejected',
            comment: String(req.body?.comment || 'Rejected by HR').trim() || 'Rejected by HR',
        });

        return res.status(200).json({ message: 'Vehicle delete request rejected.', vehicleDeleteStatus: 'none' });
    } catch (err) {
        console.error('rejectVehicleDelete:', err);
        return res.status(500).json({ message: err.message || 'Failed to reject vehicle delete request.' });
    }
};

export { performVehicleHardDelete, userHasVehicleDeletePermission, isReqHr, isReqAdmin };
