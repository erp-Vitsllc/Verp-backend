import DashboardAction from '../models/DashboardAction.js';
import { emailFrontendUrl } from './resolveFrontendBaseUrl.js';
import { ON_LEAVE_ADVANCE_NOTICE_DAYS } from './assetOperationalFlags.js';
import { isEmployeeActiveForNotifications } from './applyEmployeeLeftUserStatus.js';

const buildExpiryMessage = ({ kind, daysLeft, expiryDate }) => {
    const dateLabel = expiryDate.toLocaleDateString('en-GB');
    const isToday = daysLeft === 0;
    const isOverdue = daysLeft < 0;
    const overdueLabel =
        daysLeft === -1 ? '1 day overdue' : `${Math.abs(daysLeft)} days overdue`;

    if (kind === 'service') {
        if (isToday) {
            return `Service duration ends today (${dateLabel}). Extend the duration or mark the asset Live.`;
        }
        if (isOverdue) {
            return `Service duration ended ${dateLabel} — ${overdueLabel}. Extend the duration or mark the asset Live.`;
        }
        return null;
    }

    if (kind === 'leave') {
        if (daysLeft === ON_LEAVE_ADVANCE_NOTICE_DAYS) {
            return `On Leave duration ends in ${ON_LEAVE_ADVANCE_NOTICE_DAYS} days (${dateLabel}). Extend the duration or mark the asset On Duty.`;
        }
        if (isOverdue) {
            return `On Leave duration ended ${dateLabel} — ${overdueLabel}. Extend the duration or mark the asset On Duty.`;
        }
        return null;
    }

    return null;
};

/**
 * Bell / dashboard row for service or leave duration expiry (today or overdue).
 */
export async function upsertOperationalExpiryDashboardTask({
    asset,
    recipient,
    requestType,
    kind,
    expiryDate,
    daysLeft,
}) {
    const assigneeId = recipient?._id;
    if (!assigneeId || !asset?._id) return false;
    if (!isEmployeeActiveForNotifications(recipient)) return false;

    const extra2 = buildExpiryMessage({ kind, daysLeft, expiryDate });
    if (!extra2) return false;

    const isToday = daysLeft === 0;

    const extra3 = JSON.stringify({
        focusCard: 'operationalExpiry',
        kind,
        assetMongoId: String(asset._id),
        detailsPath: `${emailFrontendUrl()}/HRM/Asset/details/${asset._id}?focusCard=operationalExpiry`,
    });

    const existing = await DashboardAction.findOne({
        requestId: asset._id,
        requestType,
        status: 'Pending',
        assignedTo: assigneeId,
        extra3: { $regex: `"kind"\\s*:\\s*"${kind}"`, $options: 'i' },
    }).lean();

    const extra1 =
        kind === 'service'
            ? isToday
                ? `Asset Service due today — ${asset.assetId} - ${asset.name}`
                : `Asset Service overdue — ${asset.assetId} - ${asset.name}`
            : daysLeft === ON_LEAVE_ADVANCE_NOTICE_DAYS
              ? `On Leave ends in ${ON_LEAVE_ADVANCE_NOTICE_DAYS} days — ${asset.assetId} - ${asset.name}`
              : `${asset.assetId} - ${asset.name}`;

    const payload = {
        extra1,
        extra2,
        extra3,
        subjectEmployeeId: recipient.employeeId || asset.assetId,
        subjectName: `${recipient.firstName || ''} ${recipient.lastName || ''}`.trim() || 'Asset Holder',
        requestedByName: 'System Monitor',
    };

    if (existing) {
        await DashboardAction.findByIdAndUpdate(existing._id, payload);
        return true;
    }

    await DashboardAction.create({
        assignedTo: assigneeId,
        assignedToEmpId: recipient.employeeId,
        requestId: asset._id,
        requestType,
        status: 'Pending',
        ...payload,
    });
    return true;
};

export async function completeOperationalExpiryDashboardTasks(assetId, kinds = ['service', 'leave']) {
    if (!assetId) return;
    const kindList = Array.isArray(kinds) ? kinds : [kinds];
    const requestTypes = [];
    if (kindList.includes('service')) requestTypes.push('Asset Overdue');
    if (kindList.includes('leave')) requestTypes.push('Asset Leave');
    if (!requestTypes.length) return;

    await DashboardAction.updateMany(
        {
            requestId: assetId,
            status: 'Pending',
            requestType: { $in: requestTypes },
            extra3: {
                $regex: `"focusCard"\\s*:\\s*"operationalExpiry"`,
                $options: 'i',
            },
        },
        {
            $set: {
                status: 'Approved',
                actionedDate: new Date(),
                comment: 'Operational duration updated.',
            },
        },
    );
}
