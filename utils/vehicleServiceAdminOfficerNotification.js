import DashboardAction from '../models/DashboardAction.js';
import AssetItem from '../models/AssetItem.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { sendVehicleServiceWorkflowEmail } from './sendVehicleServiceWorkflowEmail.js';

function parseDashboardMeta(extra3) {
    if (!extra3) return null;
    if (typeof extra3 === 'object') return extra3;
    try {
        return JSON.parse(String(extra3));
    } catch {
        return null;
    }
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
 * Stays Pending until closeAdminOfficerServiceTrackNotification (on Complete Service —
 * Accounts Zoho / Make Payment is Accounts-only after that).
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
    notifyAssignee = true,
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
    const plate = [populated?.plateEmirate, populated?.plateNumber].filter(Boolean).join(' ').trim();
    const isInitiated = String(event || '').toLowerCase() === 'initiated';
    const actorName = String(requestedByName || 'A user').trim() || 'A user';
    const stageLabel = isInitiated
        ? `${serviceTypeLabel} initiated — please complete`
        : `${serviceTypeLabel} created — please complete`;
    const actionLabel = isInitiated
        ? `Please complete ${serviceTypeLabel}`
        : `Please complete ${serviceTypeLabel}`;
    const assetLabel = `${asset.assetId || ''}${plate ? ` (${plate})` : ''}`;
    const adminDetailLine = isInitiated
        ? `A ${serviceTypeLabel} was initiated by ${actorName} for ${assetLabel}. Please open the request and complete this ${serviceTypeLabel}.`
        : `A ${serviceTypeLabel} was created by ${actorName} for ${assetLabel}. Please open the request and complete this ${serviceTypeLabel}.`;
    const inboxExtra2 = isInitiated
        ? `Initiated by ${actorName} — please complete ${serviceTypeLabel}`
        : `Created by ${actorName} — please complete ${serviceTypeLabel}`;
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
                extra1: `${asset.assetId || asset.name || ''} — ${serviceTypeLabel}`,
                extra2: inboxExtra2,
                extra3,
            },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    if (sendEmail) {
        await sendVehicleServiceWorkflowEmail({
            recipient: adminOfficer,
            asset: populated || asset,
            stageLabel,
            actionLabel,
            detailLine: adminDetailLine,
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
            await sendVehicleServiceWorkflowEmail({
                recipient: subjectEmp,
                asset: populated || asset,
                stageLabel: isInitiated
                    ? `${serviceTypeLabel} initiated`
                    : `${serviceTypeLabel} created`,
                actionLabel: serviceTypeLabel,
                detailLine: isInitiated
                    ? `${actorName} initiated a ${serviceTypeLabel} request for your assigned vehicle ${assetLabel}.`
                    : `A ${serviceTypeLabel} request was created for your assigned vehicle ${assetLabel}.`,
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
            // Only Admin Officer rows — never touch Accounts Make Payment / billing bells.
            if (!isAdminAssignee && !isCreateTrack) return false;
            // Accounts-only oil stages must stay open even if somehow assigned wrongly.
            const oilStage = String(meta?.oilStage || '').toLowerCase();
            if (oilStage === 'accounts_payment' || oilStage === 'accounts_quote') return false;
            if (!targetServiceId) return isCreateTrack || isAdminAssignee;
            if (!meta?.serviceRecordId) return isCreateTrack || isAdminAssignee;
            return String(meta.serviceRecordId) === targetServiceId;
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
