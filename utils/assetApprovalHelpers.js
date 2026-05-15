import EmployeeBasic from '../models/EmployeeBasic.js';
import User from '../models/User.js';
import { isUserActiveInFlowchart } from './getDepartmentHOD.js';
import { isUserAdministrator } from '../services/permissionService.js';

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
    const isJwtAdmin = req.user?.isAdmin === true || req.user?.role === 'Admin' || req.user?.role === 'ROOT';
    const isSysAdmin = await isUserAdministrator(req.user?.id);
    if (isJwtAdmin || isSysAdmin) return true;

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

/**
 * New asset creation: regular users → Draft or Submitted for Approval only.
 * Asset Controller / Admin → Unassigned pool on createUnassigned (or omit intent), optional draft / submit paths.
 */
export async function resolveNewAssetCreationStatus(req, { creationIntent, assetController }) {
    const canDirect = await userCanDirectAddAssetToPool(req, assetController);
    const intent = String(creationIntent ?? '').trim();

    if (!canDirect) {
        if (intent === 'createUnassigned') {
            return {
                error: 'Only Asset Controller or Administrator can add assets directly as Unassigned.',
                status: 403
            };
        }
        if (!assetController?._id) {
            return {
                error: 'Asset controller is not assigned in the ERP flowchart.',
                status: 403
            };
        }
        if (intent === 'saveDraft') {
            return { initialStatus: 'Draft', actionRequiredBy: null, canDirectAddAsset: false };
        }
        return {
            initialStatus: 'Submitted for Approval',
            actionRequiredBy: assetController._id,
            canDirectAddAsset: false
        };
    }

    if (intent === 'saveDraft') {
        return { initialStatus: 'Draft', actionRequiredBy: null, canDirectAddAsset: true };
    }
    if (intent === 'submitForApproval') {
        if (!assetController?._id) {
            return {
                error: 'Asset controller is not assigned in the ERP flowchart.',
                status: 403
            };
        }
        return {
            initialStatus: 'Submitted for Approval',
            actionRequiredBy: assetController._id,
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
