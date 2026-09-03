import AssetItem from '../models/AssetItem.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import User from '../models/User.js';
import DashboardAction from '../models/DashboardAction.js';
import { sendAssetActionApprovalEmail } from './sendAssetActionApprovalEmail.js';

export const NO_PORTAL_NO_REPORTEE_OWNER_APPROVAL_MESSAGE =
    'This assigned employee has no user account, and no primary reportee. Set a primary reportee (with a login) on their profile before sending Leave / End of Services — otherwise approval waits forever on someone who cannot log in.';

const OWNER_TRANSFER_PENDING_ACTIONS = new Set(['Leave', 'Return Asset']);

export const assigneeHasCompanyEmailOnRecord = (emp) =>
    !!(emp?.companyEmail && String(emp.companyEmail).trim().length > 0);

const empDisplayName = (emp) => {
    if (!emp || typeof emp !== 'object') return '';
    const n = `${emp.firstName || ''} ${emp.lastName || ''}`.trim();
    if (n) return n;
    if (emp.employeeId) return String(emp.employeeId);
    return '';
};

const idStr = (ref) => {
    if (!ref) return '';
    if (typeof ref === 'object') return String(ref._id || ref.id || '');
    return String(ref);
};

const findActiveUserForEmployee = async (emp) => {
    const empId = emp?.employeeId ? String(emp.employeeId).trim() : '';
    if (!empId) return null;
    const escaped = empId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
    return User.findOne({
        employeeId: { $regex: new RegExp(`^${escaped}$`, 'i') },
        status: 'Active',
    })
        .select('enablePortalAccess employeeId')
        .lean()
        .catch(() => null);
};

/** Leave / AC-return: employee can approve only if they can log in AND have a company email. */
export const assigneeCanSelfApproveOwnerTransfer = async (emp) => {
    if (!emp) return false;
    if (emp.enablePortalAccess === false) return false;
    if (!assigneeHasCompanyEmailOnRecord(emp)) return false;
    const linkedUser = await findActiveUserForEmployee(emp);
    if (!linkedUser) return false;
    return linkedUser.enablePortalAccess !== false;
};

const loadOwnerActionApproverDoc = async (empRef) => {
    const id = empRef?._id || empRef;
    if (!id) return null;
    return EmployeeBasic.findById(id)
        .select('_id employeeId firstName lastName companyEmail workEmail enablePortalAccess')
        .lean()
        .catch(() => null);
};

/**
 * When Asset Controller sends Leave / End of Services / Return to the holder:
 * holder with login + company email approves; otherwise primary reportee approves.
 */
export const resolveOwnerTransferApprover = async (ownerEmp) => {
    const ownerId = ownerEmp?._id || ownerEmp;
    if (!ownerId) {
        return { ok: false, message: 'Asset has no assigned owner to approve this transfer.' };
    }

    const ownerDoc = await EmployeeBasic.findById(ownerId)
        .select(
            '_id employeeId firstName lastName companyEmail workEmail enablePortalAccess primaryReportee',
        )
        .populate(
            'primaryReportee',
            '_id employeeId firstName lastName companyEmail workEmail enablePortalAccess',
        )
        .lean()
        .catch(() => null);
    if (!ownerDoc?._id) {
        return { ok: false, message: 'Asset has no assigned owner to approve this transfer.' };
    }

    if (await assigneeCanSelfApproveOwnerTransfer(ownerDoc)) {
        const approver = await loadOwnerActionApproverDoc(ownerDoc);
        return { ok: true, approver: approver || ownerDoc, delegatedFromOwner: false, owner: ownerDoc };
    }

    const pr = ownerDoc.primaryReportee;
    const prId = pr?._id || pr;
    if (!prId) {
        return { ok: false, message: NO_PORTAL_NO_REPORTEE_OWNER_APPROVAL_MESSAGE };
    }
    const approver = await loadOwnerActionApproverDoc(prId);
    if (!approver?._id) {
        return { ok: false, message: NO_PORTAL_NO_REPORTEE_OWNER_APPROVAL_MESSAGE };
    }
    return {
        ok: true,
        approver,
        delegatedFromOwner: true,
        owner: ownerDoc,
    };
};

export const looksLikeOwnerTransferApproval = (asset) => {
    if (!OWNER_TRANSFER_PENDING_ACTIONS.has(String(asset?.pendingAction || ''))) return false;
    if (!asset?.assignedTo) return false;
    const role = String(asset.pendingActionDetails?.requestedByRole || '').toLowerCase();
    if (role === 'assignee' || role === 'companycoordinator') return false;
    const ownerId = asset.assignedTo?._id?.toString?.() || asset.assignedTo?.toString?.() || '';
    const requestedById =
        asset.pendingActionDetails?.requestedBy?._id?.toString?.() ||
        asset.pendingActionDetails?.requestedBy?.toString?.() ||
        '';
    if (requestedById && ownerId && requestedById === ownerId) return false;
    return true;
};

export const applyOwnerTransferApproverHealToAsset = async (asset) => {
    if (!looksLikeOwnerTransferApproval(asset)) return false;
    const ownerResolved = await resolveOwnerTransferApprover(asset.assignedTo);
    if (!ownerResolved.ok || !ownerResolved.approver?._id) return false;
    const expectedId = ownerResolved.approver._id.toString();
    const currentAr =
        asset.actionRequiredBy?._id?.toString?.() ||
        asset.actionRequiredBy?.toString?.() ||
        '';
    const delegated = ownerResolved.delegatedFromOwner === true;
    const flagNeedsHeal = delegated && asset.pendingActionDetails?.ownerApprovalDelegated !== true;
    const nameNeedsHeal = !String(asset.pendingActionDetails?.waitingForName || '').trim();
    if (currentAr === expectedId && !flagNeedsHeal && !nameNeedsHeal) return false;

    const rawDetails = asset.pendingActionDetails;
    const detailsBase =
        rawDetails && typeof rawDetails === 'object'
            ? typeof rawDetails.toObject === 'function'
                ? rawDetails.toObject()
                : { ...rawDetails }
            : {};
    const waitingName =
        `${ownerResolved.approver.firstName || ''} ${ownerResolved.approver.lastName || ''}`.trim() ||
        (ownerResolved.approver.employeeId ? String(ownerResolved.approver.employeeId) : '');
    const nextDetails = {
        ...detailsBase,
        ownerApprovalDelegated: delegated,
        waitingForId: ownerResolved.approver._id,
        waitingForName: waitingName,
    };
    delete nextDetails._id;

    await AssetItem.updateOne(
        { _id: asset._id },
        {
            $set: {
                actionRequiredBy: expectedId,
                pendingActionDetails: nextDetails,
            },
        },
    );
    asset.actionRequiredBy = ownerResolved.approver;
    asset.pendingActionDetails = nextDetails;

    const dashFilter = {
        requestId: asset._id,
        status: 'Pending',
        $or: [
            { requestType: { $in: ['Asset Leave', 'Asset Return'] } },
            { extra2: { $in: ['Leave', 'Return Asset'] } },
        ],
    };
    await DashboardAction.updateMany(dashFilter, {
        $set: {
            assignedTo: expectedId,
            ...(ownerResolved.approver.employeeId
                ? { assignedToEmpId: ownerResolved.approver.employeeId }
                : {}),
        },
    }).catch(() => null);

    if (currentAr !== expectedId) {
        await sendAssetActionApprovalEmail(
            asset,
            String(asset.pendingAction || 'Leave'),
            ownerResolved.approver,
            { name: 'Asset Controller' },
            asset.pendingActionDetails?.reason || '',
            [],
        ).catch(() => null);
    }
    return true;
};

/** Re-route AC-raised Leave / Return sitting on a holder who cannot log in onto their primary reportee. */
export const healMisroutedOwnerTransferApprovals = async () => {
    try {
        const pendingAssets = await AssetItem.find({
            pendingAction: { $in: ['Leave', 'Return Asset'] },
            assignedTo: { $ne: null },
        })
            .select('assetId pendingAction pendingActionDetails actionRequiredBy assignedTo')
            .populate({
                path: 'assignedTo',
                select: '_id employeeId firstName lastName enablePortalAccess primaryReportee companyEmail workEmail',
                populate: { path: 'primaryReportee', select: '_id employeeId firstName lastName' },
            })
            .limit(200)
            .lean();
        for (const asset of pendingAssets) {
            await applyOwnerTransferApproverHealToAsset(asset);
        }
    } catch (err) {
        console.error('[assetOwnerTransferApprover] heal failed:', err?.message || err);
    }
};

/**
 * Same waiting name/kind for tools list rows and details.
 * AC-raised Leave / Return must never display the flowchart Asset Controller.
 */
export const buildPendingActionWaitingDisplay = (asset, designatedAssetController = null) => {
    const pending = String(asset?.pendingAction || '');
    const details = asset?.pendingActionDetails && typeof asset.pendingActionDetails === 'object'
        ? asset.pendingActionDetails
        : {};
    const storedName = String(details.waitingForName || '').trim();
    const arName = empDisplayName(asset?.actionRequiredBy);
    const arId = idStr(asset?.actionRequiredBy);
    const acId = idStr(designatedAssetController) || idStr(asset?.assetController) || idStr(asset?.designatedAssetController);
    const assignee = asset?.assignedTo;
    const assigneeId = idStr(assignee);
    const assigneeName = empDisplayName(assignee);
    const reportee = assignee?.primaryReportee;
    const reporteeName = empDisplayName(reportee);
    const reporteeId = idStr(reportee);
    const waitingId = idStr(details.waitingForId) || arId;
    const role = String(details.requestedByRole || '').toLowerCase();
    const requestedById = idStr(details.requestedBy);
    const assigneeStarted =
        role === 'assignee' ||
        role === 'companycoordinator' ||
        (!!requestedById && !!assigneeId && requestedById === assigneeId);
    const delegated =
        details.ownerApprovalDelegated === true ||
        (!!waitingId && !!reporteeId && waitingId === reporteeId);

    const pack = (name, kind, id) => ({
        waitingForName: name || '',
        waitingForKind: kind || '',
        waitingForId: id || '',
    });

    if (pending === 'Leave' || pending === 'Return Asset') {
        if (!assigneeStarted) {
            const showingAc = !!(acId && ((waitingId && waitingId === acId) || (arId && arId === acId)));
            if (delegated && reporteeName) {
                const name = waitingId === reporteeId && storedName ? storedName : reporteeName;
                return pack(name, 'reportee', reporteeId || waitingId);
            }
            if (showingAc) {
                const noEmail = !assigneeHasCompanyEmailOnRecord(assignee);
                const noPortal = assignee?.enablePortalAccess === false;
                if ((noEmail || noPortal) && reporteeName) {
                    return pack(reporteeName, 'reportee', reporteeId);
                }
                if (assigneeName) return pack(assigneeName, 'employee', assigneeId);
                if (reporteeName) return pack(reporteeName, 'reportee', reporteeId);
            }
            if (storedName) {
                const kind = delegated || waitingId === reporteeId
                    ? 'reportee'
                    : waitingId === assigneeId
                        ? 'employee'
                        : 'other';
                return pack(storedName, kind, waitingId);
            }
            if (arName) {
                const kind = arId === reporteeId ? 'reportee' : arId === assigneeId ? 'employee' : 'other';
                return pack(arName, kind, arId);
            }
            if (reporteeName) return pack(reporteeName, 'reportee', reporteeId);
            if (assigneeName) return pack(assigneeName, 'employee', assigneeId);
            return pack('', '', '');
        }
        const name = storedName || arName || empDisplayName(designatedAssetController);
        return pack(name, 'other', waitingId || arId || acId);
    }

    if (!pending) return pack('', '', '');
    const name = storedName || arName;
    const kind = delegated ? 'reportee' : waitingId && waitingId === assigneeId ? 'employee' : name ? 'other' : '';
    return pack(name, kind, waitingId || arId);
};
