import AssetItem from '../models/AssetItem.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import DashboardAction from '../models/DashboardAction.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { sendAssetServiceEmail } from './sendAssetServiceEmail.js';

const SERVICE_STATUSES = ['Service', 'On Service'];

const utcDayStart = (value) => {
    const d = value ? new Date(value) : new Date();
    if (Number.isNaN(d.getTime())) return null;
    d.setHours(0, 0, 0, 0);
    return d;
};

/** Calendar days from today to expiry (0 = expires today, negative = overdue). */
export const serviceDaysUntilExpiry = (expiryDate, today = new Date()) => {
    const start = utcDayStart(today);
    const end = utcDayStart(expiryDate);
    if (!start || !end) return null;
    return Math.ceil((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
};

export const collectAssetServiceRecipients = async (asset) => {
    const recipients = [];
    const assetController = await getDepartmentHOD('assetcontroller');
    if (assetController) recipients.push(assetController);

    if (asset?.assignedTo) {
        const assignedPerson = await EmployeeBasic.findById(asset.assignedTo)
            .select('firstName lastName employeeId companyEmail workEmail email primaryReportee')
            .lean();
        if (assignedPerson) {
            const hasEmail = !!(assignedPerson.companyEmail || assignedPerson.workEmail || assignedPerson.email);
            let targetRecipient = assignedPerson;
            if (!hasEmail && assignedPerson.primaryReportee) {
                const manager = await EmployeeBasic.findById(assignedPerson.primaryReportee)
                    .select('firstName lastName employeeId companyEmail workEmail email')
                    .lean();
                if (manager) targetRecipient = manager;
            }
            const isDuplicate = recipients.some((r) => String(r._id) === String(targetRecipient._id));
            if (!isDuplicate) recipients.push(targetRecipient);
        }
    }

    return recipients;
};

/**
 * Mark pending service-overdue bell/dashboard tasks as completed for an asset.
 */
export const completeAssetServiceOverdueTasks = async (assetId, actionedBy = null) => {
    if (!assetId) return;
    await DashboardAction.updateMany(
        {
            requestId: assetId,
            status: 'Pending',
            requestType: 'Asset Overdue',
        },
        {
            $set: {
                status: 'Approved',
                actionedDate: new Date(),
                comment: 'Service window updated (Extend / Live).',
                ...(actionedBy ? { actionedBy } : {}),
            },
        },
    );
};

const upsertServiceExpiryDashboardTask = async ({ asset, recipient, expiryDate, daysLeft }) => {
    const assigneeId = recipient?._id;
    if (!assigneeId) return;

    const dateLabel = expiryDate.toLocaleDateString('en-GB');
    let extra2;
    if (daysLeft === 0) {
        extra2 = `Service return due today (${dateLabel}). Use Extend or Mark Live on the On Service list.`;
    } else if (daysLeft < 0) {
        const overdueDays = Math.abs(daysLeft);
        const overdueLabel =
            overdueDays === 1 ? '1 day overdue' : `${overdueDays} days overdue`;
        extra2 = `Service return due ${dateLabel} — ${overdueLabel}. Use Extend or Mark Live on the On Service list.`;
    } else {
        return;
    }

    const existing = await DashboardAction.findOne({
        requestId: asset._id,
        requestType: 'Asset Overdue',
        status: 'Pending',
        assignedTo: assigneeId,
    }).lean();

    if (existing) {
        await DashboardAction.findByIdAndUpdate(existing._id, {
            extra1: `${asset.assetId} - ${asset.name}`,
            extra2,
        });
        return;
    }

    await DashboardAction.create({
        assignedTo: assigneeId,
        assignedToEmpId: recipient.employeeId,
        requestId: asset._id,
        requestType: 'Asset Overdue',
        subjectEmployeeId: recipient.employeeId || asset.assetId,
        subjectName: `${recipient.firstName || ''} ${recipient.lastName || ''}`.trim() || 'Asset Controller',
        requestedByName: 'System Monitor',
        extra1: `${asset.assetId} - ${asset.name}`,
        extra2,
        status: 'Pending',
    });
};

/**
 * Daily checks for tools/equipment sent on service:
 * - Expiry date === today → one email + bell + dashboard task
 * - Expiry date &lt; today → bell + dashboard task only (no email)
 */
const closeStaleOverdueTasks = async () => {
    const pending = await DashboardAction.find({
        requestType: 'Asset Overdue',
        status: 'Pending',
    })
        .select('requestId')
        .lean();

    for (const row of pending) {
        const asset = await AssetItem.findById(row.requestId).select('status').lean();
        const stillOnService =
            asset && SERVICE_STATUSES.some((s) => String(asset.status) === s);
        if (!stillOnService) {
            await DashboardAction.updateOne(
                { _id: row._id },
                {
                    $set: {
                        status: 'Approved',
                        actionedDate: new Date(),
                        comment: 'Asset no longer on service.',
                    },
                },
            );
        }
    }
};

export const processAssetServiceOverdue = async () => {
    await closeStaleOverdueTasks();

    const assetsInService = await AssetItem.find({
        status: { $in: SERVICE_STATUSES },
    }).select('assetId name status assignedTo services');

    const today = new Date();
    let expiryEmailCount = 0;
    let expiryTaskCount = 0;

    for (const assetDoc of assetsInService) {
        const services = Array.isArray(assetDoc.services) ? assetDoc.services : [];
        const liveService = services.length ? services[services.length - 1] : null;
        if (!liveService?.expiryDate) continue;

        const expiryDate = new Date(liveService.expiryDate);
        if (Number.isNaN(expiryDate.getTime())) continue;

        const daysLeft = serviceDaysUntilExpiry(expiryDate, today);
        if (daysLeft == null) continue;

        const recipients = await collectAssetServiceRecipients(assetDoc);
        const primaryRecipient = recipients[0];

        const ensureExpiryDashboardTask = async () => {
            if (!primaryRecipient) return;
            await upsertServiceExpiryDashboardTask({
                asset: assetDoc,
                recipient: primaryRecipient,
                expiryDate,
                daysLeft,
            });
            expiryTaskCount += 1;
            if (!liveService.serviceOverdueTaskAt) {
                liveService.serviceOverdueTaskAt = new Date();
            }
        };

        // Service end date is today: email once + bell + dashboard task.
        if (daysLeft === 0) {
            if (!liveService.expiryDayEmailSentAt) {
                for (const recipient of recipients) {
                    await sendAssetServiceEmail({
                        asset: assetDoc,
                        recipient,
                        type: 'DurationComplete',
                        details: {
                            serviceDuration: liveService.serviceDuration,
                            description: liveService.description,
                        },
                        sender: { firstName: 'System', lastName: 'Automated' },
                    });
                }
                liveService.expiryDayEmailSentAt = new Date();
                expiryEmailCount += 1;
            }
            await ensureExpiryDashboardTask();
            await assetDoc.save();
            continue;
        }

        // Overdue: bell + dashboard only (no email).
        if (daysLeft < 0) {
            await ensureExpiryDashboardTask();
            await assetDoc.save();
        }
    }

    return {
        checked: assetsInService.length,
        expiryEmailCount,
        expiryTaskCount,
    };
};
