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
 * Open (or refresh) Admin Officer inbox task when any vehicle service is created.
 * Stays Pending until closeAdminOfficerServiceTrackNotification is called on completion.
 */
export async function notifyAdminOfficerOnVehicleServiceCreated({
    asset,
    serviceRecordId,
    serviceType,
    requestedByName = 'System',
    sendEmail = true,
}) {
    const adminOfficer = await getDepartmentHOD('admincontroller');
    if (!adminOfficer?._id || !asset?._id || !serviceRecordId) return;

    const populated = await loadAssetWithAssignee(asset);
    const serviceTypeLabel = String(serviceType || 'Service').trim();
    const extra3 = buildAdminOfficerServiceTrackMeta(populated || asset, serviceRecordId, serviceTypeLabel);
    const linkPath = vehicleServiceDetailsPath(asset._id, serviceRecordId, serviceTypeLabel);
    const subjectEmp = populated?.assignedTo || null;
    const plate = [populated?.plateEmirate, populated?.plateNumber].filter(Boolean).join(' ').trim();

    await DashboardAction.findOneAndUpdate(
        {
            requestId: asset._id,
            assignedTo: adminOfficer._id,
            requestType: 'Vehicle Service Request',
            status: 'Pending',
            extra3,
        },
        {
            assignedToEmpId: adminOfficer.employeeId,
            requestType: 'Vehicle Service Request',
            status: 'Pending',
            subjectEmployeeId: subjectEmp?.employeeId,
            subjectName: subjectEmp
                ? `${subjectEmp.firstName || ''} ${subjectEmp.lastName || ''}`.trim()
                : '',
            requestedByName: requestedByName || '',
            requestedDate: new Date(),
            extra1: `${asset.assetId || asset.name || ''} — ${serviceTypeLabel}`,
            extra2: 'Service open — manage until completed',
            extra3,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    if (sendEmail) {
        await sendVehicleServiceWorkflowEmail({
            recipient: adminOfficer,
            asset: populated || asset,
            stageLabel: 'New vehicle service request',
            actionLabel: `${serviceTypeLabel} created`,
            detailLine: `${requestedByName} created a ${serviceTypeLabel} request for ${asset.assetId || ''}${plate ? ` (${plate})` : ''}. Open the service details page — this task closes when the service is completed.`,
            linkPath,
        });
    }
}

/** Close Admin Officer create-track notification for one service (on completion only). */
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

    const pendingRows = await DashboardAction.find({
        requestId: assetObjectId,
        assignedTo: adminOfficer._id,
        requestType: 'Vehicle Service Request',
        status: 'Pending',
    })
        .select('_id extra3')
        .lean();

    const idsToClose = pendingRows
        .filter((row) => {
            const meta = parseDashboardMeta(row.extra3);
            if (!meta?.adminOfficerServiceTrack) return false;
            if (!targetServiceId) return true;
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
