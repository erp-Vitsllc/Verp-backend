import AssetItem from '../models/AssetItem.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import DashboardAction from '../models/DashboardAction.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { resolveEmployeeEmail } from './resolveEmployeeEmail.js';
import { sendAssetServiceEmail } from './sendAssetServiceEmail.js';
import { onServiceQueryFilter, isServiceActive } from './assetOperationalFlags.js';
import {
    upsertOperationalExpiryDashboardTask,
} from './upsertOperationalExpiryDashboardTask.js';

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
    const seen = new Set();

    const pushIfHasCompanyEmail = (emp) => {
        if (!emp?._id) return;
        const id = String(emp._id);
        if (seen.has(id)) return;
        const { email } = resolveEmployeeEmail(emp);
        if (!email) return;
        seen.add(id);
        recipients.push(emp);
    };

    const assetController = await getDepartmentHOD('assetcontroller');
    pushIfHasCompanyEmail(assetController);

    if (asset?.assignedTo) {
        const assignedPerson = await EmployeeBasic.findById(asset.assignedTo)
            .select('firstName lastName employeeId companyEmail workEmail primaryReportee')
            .lean();
        pushIfHasCompanyEmail(assignedPerson);
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

/**
 * Daily checks for tools/equipment sent on service:
 * - Expiry date === today → one email + bell + dashboard task (AC + assigned owner)
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
        const asset = await AssetItem.findById(row.requestId).select('status onServiceActive').lean();
        const stillOnService = asset && isServiceActive(asset);
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

    const assetsInService = await AssetItem.find(onServiceQueryFilter()).select(
        'assetId name status onServiceActive assignedTo services',
    );

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

        const ensureExpiryDashboardTasks = async () => {
            for (const recipient of recipients) {
                const created = await upsertOperationalExpiryDashboardTask({
                    asset: assetDoc,
                    recipient,
                    requestType: 'Asset Overdue',
                    kind: 'service',
                    expiryDate,
                    daysLeft,
                });
                if (created) expiryTaskCount += 1;
            }
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
                            expiresToday: true,
                        },
                        sender: { firstName: 'System', lastName: 'Automated' },
                    });
                }
                liveService.expiryDayEmailSentAt = new Date();
                expiryEmailCount += 1;
            }
            await ensureExpiryDashboardTasks();
            await assetDoc.save();
            continue;
        }

        // Overdue: bell + dashboard only (no email).
        if (daysLeft < 0) {
            await ensureExpiryDashboardTasks();
            await assetDoc.save();
        }
    }

    return {
        checked: assetsInService.length,
        expiryEmailCount,
        expiryTaskCount,
    };
};
