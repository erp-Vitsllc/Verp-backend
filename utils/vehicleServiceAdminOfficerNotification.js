import DashboardAction from '../models/DashboardAction.js';
import AssetItem from '../models/AssetItem.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { sendVehicleServiceWorkflowEmail } from './sendVehicleServiceWorkflowEmail.js';
import {
    vehicleServicePendingCopy,
    vehicleServiceActorName,
} from './vehicleServiceNotificationCopy.js';

function parseDashboardMeta(extra3) {
    if (!extra3) return null;
    if (typeof extra3 === 'object') return extra3;
    try {
        return JSON.parse(String(extra3));
    } catch {
        return null;
    }
}

/** True for Accounts Make Payment / Zoho billing inbox rows (not Admin Officer track). */
export function isVehicleServiceAccountsBillingNotification(row = {}) {
    const meta = parseDashboardMeta(row.extra3);
    if (meta?.adminOfficerServiceTrack) return false;
    const stage = String(meta?.oilStage || meta?.accountsStage || '').toLowerCase();
    if (['accounts_payment', 'accounts_quote', 'pending_accounts', 'pending_billing'].includes(stage)) {
        return true;
    }
    const blob = `${row.extra1 || ''} ${row.extra2 || ''}`.toLowerCase();
    return (
        /\bmake payment\b/.test(blob) ||
        /accounts billing/.test(blob) ||
        /zoho bill/.test(blob) ||
        /submit to zoho/.test(blob)
    );
}

/**
 * If Admin Officer already has the create-to-complete bell for this service,
 * update that row instead of opening a second Pending notification.
 * @returns {Promise<boolean>} true when the stage row was folded into the track
 */
export async function foldIntoAdminOfficerServiceTrackIfOpen({
    requestId,
    assignedTo,
    extra1,
    extra2,
    extra3,
}) {
    const meta = parseDashboardMeta(extra3);
    if (meta?.adminOfficerServiceTrack) return false;
    if (isVehicleServiceAccountsBillingNotification({ extra1, extra2, extra3 })) return false;
    const serviceRecordId = String(meta?.serviceRecordId || '').trim();
    if (!requestId || !assignedTo || !serviceRecordId) return false;

    const adminOfficer = await getDepartmentHOD('admincontroller');
    if (!adminOfficer?._id || String(assignedTo) !== String(adminOfficer._id)) return false;

    const pendingRows = await DashboardAction.find({
        requestId,
        requestType: 'Vehicle Service Request',
        status: 'Pending',
        extra3: { $regex: '"adminOfficerServiceTrack"\\s*:\\s*true', $options: 'i' },
    })
        .select('_id extra3')
        .lean();

    const track = pendingRows.find((row) => {
        const rowMeta = parseDashboardMeta(row.extra3);
        return String(rowMeta?.serviceRecordId || '') === serviceRecordId;
    });
    if (!track?._id) return false;

    const patch = { requestedDate: new Date(), assignedTo: adminOfficer._id, assignedToEmpId: adminOfficer.employeeId };
    if (extra1 != null) patch.extra1 = extra1;
    if (extra2 != null) patch.extra2 = extra2;
    await DashboardAction.updateOne({ _id: track._id }, { $set: patch });
    await closeDuplicateAdminVehicleServicePendingRows(requestId, serviceRecordId);
    return true;
}

/** Close extra Admin pending rows for the same service (keep the create-to-complete track). */
export async function closeDuplicateAdminVehicleServicePendingRows(
    requestId,
    serviceRecordId,
    { actionedBy = null, comment = 'Merged into Admin service track' } = {},
) {
    if (!requestId || !serviceRecordId) return;
    const assetObjectId = requestId?._id || requestId;
    const targetServiceId = String(serviceRecordId);
    const adminOfficer = await getDepartmentHOD('admincontroller');

    const orClauses = [
        { extra3: { $regex: '"adminOfficerServiceTrack"\\s*:\\s*true', $options: 'i' } },
    ];
    if (adminOfficer?._id) {
        orClauses.unshift({ assignedTo: adminOfficer._id });
    }

    const pendingRows = await DashboardAction.find({
        requestId: assetObjectId,
        requestType: 'Vehicle Service Request',
        status: 'Pending',
        $or: orClauses,
    })
        .select('_id extra3')
        .lean();

    const idsToClose = pendingRows
        .filter((row) => {
            const rowMeta = parseDashboardMeta(row.extra3);
            if (!rowMeta || rowMeta.adminOfficerServiceTrack) return false;
            if (String(rowMeta.serviceRecordId || '') !== targetServiceId) return false;
            const oilStage = String(rowMeta.oilStage || '').toLowerCase();
            if (oilStage === 'accounts_payment' || oilStage === 'accounts_quote') return false;
            return true;
        })
        .map((row) => row._id);

    if (!idsToClose.length) return;

    await DashboardAction.updateMany(
        { _id: { $in: idsToClose } },
        {
            status: 'Approved',
            actionedDate: new Date(),
            actionedBy: actionedBy || null,
            comment,
        },
    );
}

/**
 * Refresh the single Admin Officer track row for a service stage (never opens a second bell).
 */
export async function refreshAdminOfficerServiceTrack({
    asset,
    serviceRecordId,
    serviceType,
    pendingStage = 'Schedule',
    requestedByName = '',
    sendEmail = false,
    serviceReqNo = '',
    detailLine = '',
    detailRows = [],
}) {
    const adminOfficer = await getDepartmentHOD('admincontroller');
    if (!adminOfficer?._id || !asset?._id || !serviceRecordId) return;

    const populated = await loadAssetWithAssignee(asset);
    const serviceTypeLabel = String(serviceType || 'Service').trim();
    const extra3 = buildAdminOfficerServiceTrackMeta(populated || asset, serviceRecordId, serviceTypeLabel);
    const linkPath = vehicleServiceDetailsPath(asset._id, serviceRecordId, serviceTypeLabel);
    const subjectEmp = populated?.assignedTo || null;
    const stageLabel = String(pendingStage || 'Schedule').trim() || 'Schedule';
    const adminCopy = vehicleServicePendingCopy(
        serviceTypeLabel,
        vehicleServiceActorName(adminOfficer),
        stageLabel,
        { completeTrack: true },
    );
    const vsr =
        String(serviceReqNo || '').trim() ||
        (() => {
            try {
                const services = Array.isArray(populated?.services)
                    ? populated.services
                    : Array.isArray(asset?.services)
                        ? asset.services
                        : [];
                const match = services.find((s) => String(s?._id) === String(serviceRecordId));
                return String(match?.serviceReqNo || '').trim();
            } catch {
                return '';
            }
        })();

    await DashboardAction.findOneAndUpdate(
        {
            requestId: asset._id,
            assignedTo: adminOfficer._id,
            requestType: 'Vehicle Service Request',
            status: 'Pending',
            extra3,
        },
        {
            $set: {
                assignedTo: adminOfficer._id,
                assignedToEmpId: adminOfficer.employeeId,
                requestId: asset._id,
                requestType: 'Vehicle Service Request',
                status: 'Pending',
                subjectEmployeeId: subjectEmp?.employeeId,
                subjectName: subjectEmp
                    ? `${subjectEmp.firstName || ''} ${subjectEmp.lastName || ''}`.trim()
                    : '',
                requestedByName: requestedByName || adminCopy.actionLabel,
                requestedDate: new Date(),
                extra1: adminCopy.extra1,
                extra2: adminCopy.extra2,
                extra3,
            },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    await closeDuplicateAdminVehicleServicePendingRows(asset._id, serviceRecordId);

    if (sendEmail) {
        await sendVehicleServiceWorkflowEmail({
            recipient: adminOfficer,
            asset: populated || asset,
            stageLabel: adminCopy.stageLabel,
            actionLabel: adminCopy.actionLabel,
            detailLine: detailLine || adminCopy.detailLine,
            detailRows,
            linkPath,
            serviceReqNo: vsr,
        }).catch(() => {});
    }
}

/** Collapse duplicate Admin bells for the same service (legacy rows in DB). */
export async function healDuplicateAdminVehicleServiceInboxRows() {
    const adminOfficer = await getDepartmentHOD('admincontroller');
    if (!adminOfficer?._id) return;

    const pendingRows = await DashboardAction.find({
        requestType: 'Vehicle Service Request',
        status: 'Pending',
        $or: [
            { assignedTo: adminOfficer._id },
            { extra3: { $regex: '"adminOfficerServiceTrack"\\s*:\\s*true', $options: 'i' } },
        ],
    })
        .select('requestId extra3')
        .lean();

    const grouped = new Map();
    for (const row of pendingRows) {
        const meta = parseDashboardMeta(row.extra3);
        const serviceRecordId = String(meta?.serviceRecordId || '').trim();
        const requestId = String(row.requestId || '').trim();
        if (!serviceRecordId || !requestId) continue;
        const key = `${requestId}:${serviceRecordId}`;
        grouped.set(key, (grouped.get(key) || 0) + 1);
    }

    for (const [key, count] of grouped) {
        if (count <= 1) continue;
        const sep = key.indexOf(':');
        const requestId = key.slice(0, sep);
        const serviceRecordId = key.slice(sep + 1);
        await closeDuplicateAdminVehicleServicePendingRows(requestId, serviceRecordId);
    }

    await healAdminMisroutedAccountsBillingNotifications();
}

/** Close Make Payment / Zoho bells wrongly assigned to Admin Officer (Accounts-only). */
export async function healAdminMisroutedAccountsBillingNotifications() {
    const adminOfficer = await getDepartmentHOD('admincontroller');
    if (!adminOfficer?._id) return;

    const pendingRows = await DashboardAction.find({
        requestType: 'Vehicle Service Request',
        status: 'Pending',
        assignedTo: adminOfficer._id,
    })
        .select('_id extra1 extra2 extra3')
        .lean();

    const idsToClose = pendingRows
        .filter((row) => isVehicleServiceAccountsBillingNotification(row))
        .map((row) => row._id);

    if (!idsToClose.length) return;

    await DashboardAction.updateMany(
        { _id: { $in: idsToClose } },
        {
            status: 'Approved',
            actionedDate: new Date(),
            comment: 'Accounts Make Payment — not Admin Officer',
        },
    );
}

export function vehicleServiceDetailsPath(assetId, serviceRecordId, serviceType) {
    if (!assetId || !serviceRecordId) return null;
    const type = String(serviceType || '').trim();
    const base = `/HRM/Asset/Vehicle/details/${assetId}`;
    if (type === 'Tire Change') return `${base}/tire-change/${serviceRecordId}`;
    if (type === 'Mechanical Work') return `${base}/mechanical-work/${serviceRecordId}`;
    if (type === 'Body Work') return `${base}/body-work/${serviceRecordId}`;
    if (type === 'Accident Repair') return `${base}/accident-repair/${serviceRecordId}`;
    if (type === 'Oil Service') return `${base}/oil-service/${serviceRecordId}`;
    if (type === 'Car Wash') return `${base}?tab=service&carWashServiceId=${serviceRecordId}`;
    return `/HRM/Asset/Vehicle/service-requests/details/${assetId}/${serviceRecordId}`;
}

/** Dashboard extra3 marker — one open row per service until completed. */
export function buildAdminOfficerServiceTrackMeta(asset, serviceRecordId, serviceType) {
    const path = vehicleServiceDetailsPath(asset?._id, serviceRecordId, serviceType);
    return JSON.stringify({
        adminOfficerServiceTrack: true,
        vehicleId: asset?._id ? String(asset._id) : '',
        serviceRecordId: serviceRecordId ? String(serviceRecordId) : '',
        serviceType: String(serviceType || ''),
        detailsPath: path || '',
    });
}

async function loadAssetWithAssignee(asset) {
    if (asset?.assignedTo && typeof asset.assignedTo === 'object' && asset.assignedTo.firstName) {
        return asset;
    }
    if (!asset?._id) return asset;
    return AssetItem.findById(asset._id)
        .populate('assignedTo', 'firstName lastName employeeId')
        .lean();
}

/**
 * Open (or refresh) Admin Officer inbox task when any vehicle service is created / initiated.
 * Stays Pending until closeAdminOfficerServiceTrackNotification on Complete Service —
 * Accounts Make Payment / Zoho billing is Accounts-only (Admin does not wait on Zoho).
 *
 * Email to Admin Officer: only when sendEmail is true (callers skip when the actor
 * is already the flowchart Admin Officer).
 * @param {'created'|'initiated'} [event]
 */
export async function notifyAdminOfficerOnVehicleServiceCreated({
    asset,
    serviceRecordId,
    serviceType,
    requestedByName = 'System',
    sendEmail = true,
    notifyAssignee = false,
    event = 'created',
    serviceReqNo = '',
}) {
    const adminOfficer = await getDepartmentHOD('admincontroller');
    if (!adminOfficer?._id || !asset?._id || !serviceRecordId) return;

    const populated = await loadAssetWithAssignee(asset);
    const serviceTypeLabel = String(serviceType || 'Service').trim();
    const extra3 = buildAdminOfficerServiceTrackMeta(populated || asset, serviceRecordId, serviceTypeLabel);
    const linkPath = vehicleServiceDetailsPath(asset._id, serviceRecordId, serviceTypeLabel);
    const subjectEmp = populated?.assignedTo || null;
    const isInitiated = String(event || '').toLowerCase() === 'initiated';
    const actorName = String(requestedByName || 'A user').trim() || 'A user';
    const currentStage = isInitiated ? 'Schedule' : 'Created';
    const adminCopy = vehicleServicePendingCopy(
        serviceTypeLabel,
        vehicleServiceActorName(adminOfficer),
        currentStage,
        { completeTrack: true },
    );
    const vsr =
        String(serviceReqNo || '').trim() ||
        (() => {
            try {
                const services = Array.isArray(populated?.services)
                    ? populated.services
                    : Array.isArray(asset?.services)
                        ? asset.services
                        : [];
                const match = services.find((s) => String(s?._id) === String(serviceRecordId));
                return String(match?.serviceReqNo || '').trim();
            } catch {
                return '';
            }
        })();

    await DashboardAction.findOneAndUpdate(
        {
            requestId: asset._id,
            assignedTo: adminOfficer._id,
            requestType: 'Vehicle Service Request',
            status: 'Pending',
            extra3,
        },
        {
            $set: {
                assignedTo: adminOfficer._id,
                assignedToEmpId: adminOfficer.employeeId,
                requestId: asset._id,
                requestType: 'Vehicle Service Request',
                status: 'Pending',
                subjectEmployeeId: subjectEmp?.employeeId,
                subjectName: subjectEmp
                    ? `${subjectEmp.firstName || ''} ${subjectEmp.lastName || ''}`.trim()
                    : '',
                requestedByName: actorName,
                requestedDate: new Date(),
                extra1: adminCopy.extra1,
                extra2: adminCopy.extra2,
                extra3,
            },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    await closeDuplicateAdminVehicleServicePendingRows(asset._id, serviceRecordId);

    if (sendEmail) {
        await sendVehicleServiceWorkflowEmail({
            recipient: adminOfficer,
            asset: populated || asset,
            stageLabel: adminCopy.stageLabel,
            actionLabel: adminCopy.actionLabel,
            detailLine: adminCopy.detailLine,
            linkPath,
            serviceReqNo: vsr,
        });
    }

    // Assigned driver/user — independent of Admin Officer email (e.g. Admin Officer self-initiates).
    if (
        notifyAssignee &&
        subjectEmp?._id &&
        String(subjectEmp._id) !== String(adminOfficer._id)
    ) {
        try {
            const assigneeCopy = vehicleServicePendingCopy(
                serviceTypeLabel,
                vehicleServiceActorName(subjectEmp),
                currentStage,
            );
            await sendVehicleServiceWorkflowEmail({
                recipient: subjectEmp,
                asset: populated || asset,
                stageLabel: assigneeCopy.stageLabel,
                actionLabel: assigneeCopy.actionLabel,
                detailLine: assigneeCopy.detailLine,
                linkPath,
                serviceReqNo: vsr,
            });
        } catch (assigneeMailErr) {
            console.error('[VehicleService] Assignee create notify failed:', assigneeMailErr);
        }
    }
}

/**
 * Close Admin Officer inbox rows for one service (create-track + schedule/ready/on-service).
 * Call on Complete Service — Accounts Make Payment / Zoho billing stays Accounts-only.
 * Also safe to call again after Billed (idempotent).
 */
export async function closeAdminOfficerServiceTrackNotification({
    assetId,
    serviceRecordId,
    actionedBy = null,
    comment = 'Service completed',
    requestedByName = '',
}) {
    if (!assetId) return;

    const assetObjectId = assetId?._id || assetId;
    const targetServiceId = serviceRecordId ? String(serviceRecordId) : '';
    const adminOfficer = await getDepartmentHOD('admincontroller');
    if (!adminOfficer?._id) return;

    // Match by assignee OR create-track marker (inbox may show track via role fallback
    // when assignedTo still points at a previous Admin Officer).
    const pendingRows = await DashboardAction.find({
        requestId: assetObjectId,
        requestType: 'Vehicle Service Request',
        status: 'Pending',
        $or: [
            { assignedTo: adminOfficer._id },
            { extra3: { $regex: '"adminOfficerServiceTrack"\\s*:\\s*true', $options: 'i' } },
        ],
    })
        .select('_id extra3 assignedTo')
        .lean();

    const idsToClose = pendingRows
        .filter((row) => {
            const meta = parseDashboardMeta(row.extra3);
            const isAdminAssignee = String(row.assignedTo || '') === String(adminOfficer._id);
            const isCreateTrack = Boolean(meta?.adminOfficerServiceTrack);
            if (!isAdminAssignee && !isCreateTrack) return false;
            if (!targetServiceId) return isCreateTrack || isAdminAssignee;
            if (meta?.serviceRecordId && String(meta.serviceRecordId) !== targetServiceId) return false;
            // Close Admin track (and any billing row wrongly on Admin) on Complete Service.
            return true;
        })
        .map((row) => row._id);

    if (!idsToClose.length) return;

    await DashboardAction.updateMany(
        { _id: { $in: idsToClose } },
        {
            status: 'Approved',
            actionedDate: new Date(),
            actionedBy: actionedBy || null,
            comment: comment || 'Service completed',
            extra2: 'Completed',
            ...(requestedByName ? { requestedByName } : {}),
        },
    );
}
