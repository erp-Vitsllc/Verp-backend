import EmployeeBasic from '../models/EmployeeBasic.js';
import User from '../models/User.js';
import AssetItem from '../models/AssetItem.js';
import DashboardAction from '../models/DashboardAction.js';
import { getDepartmentHOD, isUserActiveInFlowchart } from './getDepartmentHOD.js';
import { isJwtSystemSuperUser } from '../utils/systemSuperUser.js';
import { hasPermission, isUserAdministrator } from '../services/permissionService.js';

const normEmpId = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, '');

const escapeRegExp = (value) => {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

// Build an "exact match ignoring whitespace" regex for employeeId.
const buildWhitespaceAgnosticExactRegex = (value) => {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    const parts = raw.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return null;
    const pattern = parts.map(p => escapeRegExp(p)).join('\\s*');
    return new RegExp(`^${pattern}$`, 'i');
};

/**
 * Ensure flowchart asset controller has EmployeeBasic _id (for actionRequiredBy + DashboardAction.assignedTo).
 */
export async function resolveAssetControllerEmployee(assetController) {
    if (!assetController) return null;
    if (assetController._id) {
        // Ensure we have enough fields for dashboard + email fallback logic.
        const emp = await EmployeeBasic.findById(assetController._id)
            .select('_id employeeId firstName lastName companyEmail workEmail personalEmail email primaryReportee')
            .populate('primaryReportee', 'companyEmail workEmail personalEmail email')
            .lean()
            .catch(() => null);
        return emp || assetController;
    }
    if (!assetController.employeeId) return assetController;
    const safeEmployeeIdRegex = buildWhitespaceAgnosticExactRegex(assetController.employeeId);
    if (!safeEmployeeIdRegex) return assetController;

    const emp = await EmployeeBasic.findOne({
        employeeId: { $regex: safeEmployeeIdRegex }
    })
        .select('_id employeeId firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee')
        .populate('primaryReportee', 'companyEmail workEmail personalEmail email')
        .lean();
    if (!emp) return assetController;
    return { ...assetController, ...emp };
}

/** Prefer employee directory name for dashboard / email "requested by". */
export async function getAssetRequesterDisplayName(req) {
    const fallback = (req.user?.name && String(req.user.name).trim()) || 'System';
    try {
        if (req.user?.employeeObjectId) {
            const emp = await EmployeeBasic.findById(req.user.employeeObjectId).select('firstName lastName').lean();
            if (emp) {
                const n = `${emp.firstName || ''} ${emp.lastName || ''}`.trim();
                if (n) return n;
            }
        }
        if (req.user?.employeeId) {
            const safeEmployeeIdRegex = buildWhitespaceAgnosticExactRegex(req.user.employeeId);
            if (!safeEmployeeIdRegex) return fallback;

            const emp = await EmployeeBasic.findOne({
                employeeId: { $regex: safeEmployeeIdRegex }
            })
                .select('firstName lastName')
                .lean();
            if (emp) {
                const n = `${emp.firstName || ''} ${emp.lastName || ''}`.trim();
                if (n) return n;
            }
        }
    } catch (e) {
        /* use fallback */
    }
    return fallback;
}

/** Resolve asset creator (User ref on AssetItem.createdBy) to EmployeeBasic for notifications. */
export async function resolveAssetCreatorEmployee(createdByUserId) {
    if (!createdByUserId) return null;
    try {
        const user = await User.findById(createdByUserId).select('employeeId name email companyEmail').lean();
        if (!user) return null;

        if (user.employeeId) {
            const safeEmployeeIdRegex = buildWhitespaceAgnosticExactRegex(user.employeeId);
            if (safeEmployeeIdRegex) {
                const emp = await EmployeeBasic.findOne({ employeeId: { $regex: safeEmployeeIdRegex } })
                    .select('_id employeeId firstName lastName companyEmail workEmail personalEmail email primaryReportee')
                    .populate('primaryReportee', 'companyEmail workEmail personalEmail email')
                    .lean();
                if (emp) return emp;
            }
        }
    } catch (e) {
        console.error('[resolveAssetCreatorEmployee]', e?.message || e);
    }
    return null;
}

/** JWT/system admin or active flowchart Asset Controller (incl. department HOD row). */
export async function userCanDirectAddAssetToPool(req, assetControllerEmp = null) {
    if (isJwtSystemSuperUser(req.user)) return true;

    const isSysAdmin = await isUserAdministrator(req.user?.id);
    if (isSysAdmin) return true;

    let isAssetController = false;
    try {
        isAssetController = await isUserActiveInFlowchart(req.user, 'assetcontroller');
    } catch {
        isAssetController = false;
    }

    const ac = assetControllerEmp;
    if (ac?._id && req.user?.employeeObjectId) {
        if (ac._id.toString() === req.user.employeeObjectId.toString()) isAssetController = true;
    }
    if (!isAssetController && ac?.employeeId && req.user?.employeeId) {
        if (normEmpId(ac.employeeId) === normEmpId(req.user.employeeId)) isAssetController = true;
    }
    return isAssetController;
}

/** Asset Controller or Administrator — required to assign / reassign assets. */
export async function userCanAssignAssets(req, assetControllerEmp = null) {
    return userCanDirectAddAssetToPool(req, assetControllerEmp);
}

/** Current flowchart Asset Controller as EmployeeBasic (for notifications). */
export async function getResolvedAssetControllerEmployee() {
    const acRaw = await getDepartmentHOD('assetcontroller');
    return acRaw ? resolveAssetControllerEmployee(acRaw) : null;
}

/** Current flowchart HR as EmployeeBasic (fleet vehicle assignment / return approvals). */
export async function getResolvedFleetHrEmployee() {
    const hrRaw = await getDepartmentHOD('hr');
    return hrRaw ? resolveAssetControllerEmployee(hrRaw) : null;
}

/** HR flowchart holder, administrator, or fleet asset editor — reassign / return fleet vehicles. */
export async function userCanManageFleetVehicleHandover(req) {
    if (isJwtSystemSuperUser(req.user)) return true;

    const isSysAdmin = await isUserAdministrator(req.user?.id);
    if (isSysAdmin) return true;

    let isHr = false;
    try {
        isHr = await isUserActiveInFlowchart(req.user, 'hr');
    } catch {
        isHr = false;
    }
    if (isHr) return true;

    const hrRaw = await getDepartmentHOD('hr');
    if (hrRaw?._id && req.user?.employeeObjectId) {
        if (hrRaw._id.toString() === req.user.employeeObjectId.toString()) return true;
    }
    if (hrRaw?.employeeId && req.user?.employeeId) {
        if (normEmpId(hrRaw.employeeId) === normEmpId(req.user.employeeId)) return true;
    }

    const uid = req.user?.id || req.user?._id;
    if (!uid) return false;
    return (
        (await hasPermission(uid, 'hrm_asset', 'edit')) ||
        (await hasPermission(uid, 'hrm_asset_vehicle', 'edit'))
    );
}

/** Active flowchart Admin Officer (admincontroller row). */
export async function userIsFlowchartAdminOfficer(req) {
    if (isJwtSystemSuperUser(req.user)) return true;

    let isAdminOfficer = false;
    try {
        isAdminOfficer = await isUserActiveInFlowchart(req.user, 'admincontroller');
    } catch {
        isAdminOfficer = false;
    }

    const adminHod = await getDepartmentHOD('admincontroller');
    if (adminHod?._id && req.user?.employeeObjectId) {
        if (adminHod._id.toString() === req.user.employeeObjectId.toString()) isAdminOfficer = true;
    }
    if (!isAdminOfficer && adminHod?.employeeId && req.user?.employeeId) {
        if (normEmpId(adminHod.employeeId) === normEmpId(req.user.employeeId)) isAdminOfficer = true;
    }
    return isAdminOfficer;
}

/** Flowchart Admin Officer — may assign fleet vehicles from the pool. */
export async function userCanAssignFleetVehicleAssets(req) {
    return userIsFlowchartAdminOfficer(req);
}

function hasFleetVehicleTypeName(typeName) {
    const tn = String(typeName || '').toLowerCase();
    return (
        tn.includes('vehicle') ||
        tn.includes('car') ||
        tn.includes('fleet') ||
        tn.includes('truck')
    );
}

function hasFleetVehicleRecordMarkers(asset) {
    if (!asset || typeof asset !== 'object') return false;
    if (String(asset.vehicleBrand || '').trim()) return true;
    if (String(asset.vehicleCode || '').trim()) return true;
    if (String(asset.plateEmirate || '').trim()) return true;
    if (asset.locatorDeviceId != null && asset.locatorDeviceId !== '') return true;
    const profileStatus = String(asset.vehicleProfileActivationStatus || '').trim().toLowerCase();
    if (profileStatus && profileStatus !== 'none') return true;
    const inspectionStatus = String(asset.vehicleInspectionStatus || '').trim().toLowerCase();
    if (inspectionStatus && inspectionStatus !== 'none') return true;
    if (asset.vehicleDispositionStatus != null && String(asset.vehicleDispositionStatus).trim()) {
        return true;
    }
    if (Array.isArray(asset.vehicleAccessoriesListEntries) && asset.vehicleAccessoriesListEntries.length > 0) {
        return true;
    }
    return false;
}

export function isFleetVehicleAssetFields({ plateNumber, typeName, asset } = {}) {
    const plate = String(plateNumber ?? asset?.plateNumber ?? '').trim();
    if (plate) return true;
    const tn = typeName ?? asset?.typeId?.name ?? asset?.type ?? '';
    if (hasFleetVehicleTypeName(tn)) return true;
    if (asset) return hasFleetVehicleRecordMarkers(asset);
    return false;
}

export function isFleetVehicleAsset(asset) {
    if (!asset) return false;
    return isFleetVehicleAssetFields({
        plateNumber: asset.plateNumber,
        typeName: asset.typeId?.name || asset.type || '',
        asset,
    });
}

export const FLEET_PROFILE_INACTIVE_ASSIGNMENT_MSG =
    'Vehicle profile must be active before assign, reassign, or return actions can be performed. Complete profile activation first.';

/** Fleet vehicles require `vehicleProfileActivationStatus === active` for assignment workflows. */
export function isFleetVehicleProfileActive(asset) {
    if (!asset) return false;
    if (!isFleetVehicleAssetFields({
        plateNumber: asset.plateNumber,
        typeName: asset.typeId?.name || asset.type,
        asset,
    })) {
        return true;
    }
    return String(asset.vehicleProfileActivationStatus || '').toLowerCase().trim() === 'active';
}

/** Fleet vehicles: profile activation goes to HR; tool assets use Asset Controller for creation approval. */
export async function resolveAssetCreationApproverEmployee({ plateNumber, typeName } = {}) {
    const fleet = isFleetVehicleAssetFields({ plateNumber, typeName });
    if (fleet) {
        const hrRaw = await getDepartmentHOD('hr');
        return hrRaw ? resolveAssetControllerEmployee(hrRaw) : null;
    }
    const acRaw = await getDepartmentHOD('assetcontroller');
    return acRaw ? resolveAssetControllerEmployee(acRaw) : null;
}

export function creationApproverRoleLabel({ plateNumber, typeName } = {}) {
    return isFleetVehicleAssetFields({ plateNumber, typeName }) ? 'HR' : 'Asset Controller';
}

/**
 * Resolve the current role-based creation approver for an asset (HR for fleet, AC for tools).
 * Returns null if no approver is configured. The result is fresh from the flowchart, so the
 * UI banner / inbox can show the *current* approver even when stored references are stale.
 */
export async function resolveCurrentCreationApproverForAsset(asset) {
    if (!asset) return null;
    return resolveAssetCreationApproverEmployee({
        plateNumber: asset.plateNumber,
        typeName: asset?.typeId?.name || asset?.type || '',
    });
}

/** Employee/company assignment waiting on accept/reject — not creation approval. */
export function isAssetAssignmentAcknowledgmentPending(asset) {
    if (!asset) return false;
    if (asset.pendingAction) return false;
    if (String(asset.acceptanceStatus || '') !== 'Pending') return false;
    if (!(String(asset.status || '') === 'Pending' || String(asset.status || '') === 'Assigned')) {
        return false;
    }
    return !!(asset.assignedTo || asset.assignedCompany);
}

function isAwaitingAssetCreationApproval(asset) {
    if (!asset) return false;
    if (asset.pendingAction) return false;
    if (isAssetAssignmentAcknowledgmentPending(asset)) return false;
    return (
        asset.status === 'Submitted for Approval' ||
        asset.status === 'Pending' ||
        (asset.status === 'Draft' && asset.actionRequiredBy)
    );
}

/**
 * Profile is already active but creation-approval fields were left behind — clear them so UI
 * does not keep showing the yellow "Vehicle creation approval" banner.
 */
export async function healStaleCreationApprovalAfterProfileActive(asset) {
    if (!asset?._id) return false;
    if (String(asset.vehicleProfileActivationStatus || '').toLowerCase() !== 'active') {
        return false;
    }
    if (!isAwaitingAssetCreationApproval(asset) && !asset.actionRequiredBy) {
        return false;
    }

    const nextStatus =
        asset.assignedTo || asset.assignedCompany
            ? 'Assigned'
            : asset.status === 'Submitted for Approval'
              ? 'Unassigned'
              : asset.status;

    try {
        await AssetItem.updateOne(
            { _id: asset._id },
            {
                $set: {
                    status: nextStatus,
                },
                $unset: { actionRequiredBy: 1 },
            },
        );
        asset.status = nextStatus;
        asset.actionRequiredBy = null;

        await DashboardAction.updateMany(
            { requestId: asset._id, requestType: 'Asset Approval', status: 'Pending' },
            {
                status: 'Approved',
                actionedDate: new Date(),
                comment: 'Auto-closed: vehicle profile is already active.',
            },
        );
    } catch (err) {
        console.error(
            '[healStaleCreationApprovalAfterProfileActive] failed:',
            err?.message || err,
        );
        return false;
    }

    return true;
}

/**
 * For an asset awaiting creation approval, re-point `actionRequiredBy` and any pending
 * Asset Approval DashboardAction at the *current* role holder when the stored approver is stale.
 *
 * Returns the canonical approver Employee (current role holder) or null when no approver is
 * configured. Safe no-op when the asset is not awaiting creation approval.
 */
export async function syncStaleAssetCreationApprover(asset) {
    if (!asset || !asset._id) return null;

    if (String(asset.vehicleProfileActivationStatus || '').toLowerCase() === 'active') {
        await healStaleCreationApprovalAfterProfileActive(asset);
        return null;
    }

    // Assignment acknowledgments also use status Pending — never replace assignee/reportee routing.
    if (isAssetAssignmentAcknowledgmentPending(asset)) return null;

    // Assets with active pending actions (like EOL or Loss & Damage) should not sync creation approvers.
    if (asset.pendingAction) return null;

    const awaiting = isAwaitingAssetCreationApproval(asset);
    if (!awaiting) return null;

    const currentApprover = await resolveCurrentCreationApproverForAsset(asset);
    if (!currentApprover?._id) return null;

    const storedRef = asset.actionRequiredBy;
    const storedId = storedRef?._id?.toString?.() || storedRef?.toString?.() || null;
    const currentId = currentApprover._id.toString();

    if (storedId === currentId) return currentApprover;

    try {
        await AssetItem.updateOne(
            { _id: asset._id },
            { $set: { actionRequiredBy: currentApprover._id } }
        );
        asset.actionRequiredBy = currentApprover;
    } catch (err) {
        console.error('[syncStaleAssetCreationApprover] AssetItem update failed:', err?.message || err);
    }

    try {
        await DashboardAction.updateMany(
            { requestId: asset._id, requestType: 'Asset Approval', status: 'Pending' },
            {
                $set: {
                    assignedTo: currentApprover._id,
                    assignedToEmpId: currentApprover.employeeId,
                },
            }
        );
    } catch (err) {
        console.error('[syncStaleAssetCreationApprover] DashboardAction update failed:', err?.message || err);
    }

    return currentApprover;
}

/**
 * Bulk re-route every pending Asset Approval to the current role holder for that asset
 * (HR for fleet vehicles, Asset Controller for everything else).
 *
 * Uses two `updateMany` writes (one per role) so it is O(1) round-trips regardless of how many
 * pending requests exist. Run from boot + on flowchart approve — NOT on read paths.
 */
export async function rerouteAllPendingAssetCreationApprovals({ category } = {}) {
    const wantsHr = !category || category === 'hr';
    const wantsAc = !category || category === 'assetcontroller';

    const [hrHod, acHod] = await Promise.all([
        wantsHr ? getDepartmentHOD('hr').then((r) => (r ? resolveAssetControllerEmployee(r) : null)) : null,
        wantsAc ? getDepartmentHOD('assetcontroller').then((r) => (r ? resolveAssetControllerEmployee(r) : null)) : null,
    ]);

    const pendingActions = await DashboardAction.find({
        requestType: 'Asset Approval',
        status: 'Pending',
    })
        .select('_id requestId')
        .lean();

    if (!pendingActions.length) return { fleetUpdated: 0, toolsUpdated: 0 };

    const requestIds = pendingActions.map((da) => da.requestId).filter(Boolean);
    const assets = await AssetItem.find({ _id: { $in: requestIds } })
        .select('_id plateNumber typeId')
        .populate('typeId', 'name')
        .lean();

    const fleetAssetIds = [];
    const toolsAssetIds = [];
    for (const asset of assets) {
        const fleet = isFleetVehicleAssetFields({
            plateNumber: asset.plateNumber,
            typeName: asset?.typeId?.name || '',
        });
        if (fleet) fleetAssetIds.push(asset._id);
        else toolsAssetIds.push(asset._id);
    }

    const tasks = [];
    if (wantsHr && hrHod?._id && fleetAssetIds.length) {
        tasks.push(
            AssetItem.updateMany(
                { _id: { $in: fleetAssetIds } },
                { $set: { actionRequiredBy: hrHod._id } }
            ),
            DashboardAction.updateMany(
                { requestType: 'Asset Approval', status: 'Pending', requestId: { $in: fleetAssetIds } },
                { $set: { assignedTo: hrHod._id, assignedToEmpId: hrHod.employeeId } }
            )
        );
    }
    if (wantsAc && acHod?._id && toolsAssetIds.length) {
        tasks.push(
            AssetItem.updateMany(
                { _id: { $in: toolsAssetIds } },
                { $set: { actionRequiredBy: acHod._id } }
            ),
            DashboardAction.updateMany(
                { requestType: 'Asset Approval', status: 'Pending', requestId: { $in: toolsAssetIds } },
                { $set: { assignedTo: acHod._id, assignedToEmpId: acHod.employeeId } }
            )
        );
    }

    if (!tasks.length) return { fleetUpdated: 0, toolsUpdated: 0 };

    try {
        await Promise.all(tasks);
    } catch (err) {
        console.error('[rerouteAllPendingAssetCreationApprovals] bulk update failed:', err?.message || err);
    }

    return {
        fleetUpdated: wantsHr && hrHod?._id ? fleetAssetIds.length : 0,
        toolsUpdated: wantsAc && acHod?._id ? toolsAssetIds.length : 0,
    };
}

/**
 * New asset creation: regular users → Draft or Submitted for Approval only.
 * Fleet vehicles skip creation approval — created directly as Unassigned (or Draft).
 * Asset Controller / Admin → Unassigned pool on createUnassigned (or omit intent), optional draft / submit paths.
 */
export async function resolveNewAssetCreationStatus(
    req,
    { creationIntent, approverEmp, approverLabel = 'Asset Controller', isFleetVehicle = false } = {},
) {
    const canDirect = await userCanDirectAddAssetToPool(req, approverEmp);
    const intent = String(creationIntent ?? '').trim();

    if (isFleetVehicle) {
        if (intent === 'saveDraft') {
            return { initialStatus: 'Draft', actionRequiredBy: null, canDirectAddAsset: true };
        }
        return { initialStatus: 'Unassigned', actionRequiredBy: null, canDirectAddAsset: true };
    }

    if (!canDirect) {
        if (intent === 'createUnassigned') {
            return {
                error: 'Only Asset Controller or Administrator can add assets directly as Unassigned.',
                status: 403
            };
        }
        if (!approverEmp?._id) {
            return {
                error: `${approverLabel} is not assigned in the ERP flowchart.`,
                status: 403
            };
        }
        if (intent === 'saveDraft') {
            return { initialStatus: 'Draft', actionRequiredBy: null, canDirectAddAsset: false };
        }
        return {
            initialStatus: 'Submitted for Approval',
            actionRequiredBy: approverEmp._id,
            canDirectAddAsset: false
        };
    }

    if (intent === 'saveDraft') {
        return { initialStatus: 'Draft', actionRequiredBy: null, canDirectAddAsset: true };
    }
    if (intent === 'submitForApproval') {
        if (!approverEmp?._id) {
            return {
                error: `${approverLabel} is not assigned in the ERP flowchart.`,
                status: 403
            };
        }
        return {
            initialStatus: 'Submitted for Approval',
            actionRequiredBy: approverEmp._id,
            canDirectAddAsset: true
        };
    }
    if (intent && intent !== 'createUnassigned') {
        return {
            error: 'Invalid creationIntent. Use saveDraft, submitForApproval, or createUnassigned.',
            status: 400
        };
    }
    return { initialStatus: 'Unassigned', actionRequiredBy: null, canDirectAddAsset: true };
}
