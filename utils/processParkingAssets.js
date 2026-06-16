import AssetItem from '../models/AssetItem.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import AssetHistory from '../models/AssetHistory.js';
import DashboardAction from '../models/DashboardAction.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { sendParkingReminderEmail, sendParkingDurationCompleteEmail } from './sendAssetParkingNotifications.js';
import { onLeaveQueryFilter } from './assetOperationalFlags.js';
import { upsertOperationalExpiryDashboardTask } from './upsertOperationalExpiryDashboardTask.js';

const startOfDay = (d) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
};

const daysUntilLeaveEnd = (endDate, today = new Date()) => {
    const end = startOfDay(endDate);
    const start = startOfDay(today);
    if (Number.isNaN(end.getTime())) return null;
    return Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
};

export const processParkingAssets = async () => {
    try {
        const today = startOfDay(new Date());
        const assetController = await getDepartmentHOD('assetcontroller');

        const parkedAssets = await AssetItem.find({
            ...onLeaveQueryFilter(),
            onLeaveEndDate: { $ne: null },
            assignedTo: { $ne: null }
        }).populate('assignedTo');

        for (const asset of parkedAssets) {
            if (!asset.onLeaveEndDate || !asset.assignedTo) continue;

            const diffDays = daysUntilLeaveEnd(asset.onLeaveEndDate, today);

            const assignedEmployee = await EmployeeBasic.findById(asset.assignedTo._id || asset.assignedTo)
                .select('firstName lastName employeeId companyEmail workEmail primaryReportee')
                .populate('primaryReportee', 'firstName lastName companyEmail workEmail')
                .lean();

            if (diffDays === 2 && !asset.parkingReminderSentAt) {
                await sendParkingReminderEmail({
                    asset,
                    assignedEmployee,
                    assetController,
                    daysLeft: 2
                });
                asset.parkingReminderSentAt = new Date();
                await asset.save();
            }

            if (diffDays == null) continue;

            const expiryDate = startOfDay(asset.onLeaveEndDate);
            const notifyRecipients = [assignedEmployee, assetController].filter((r) => r?._id);

            const ensureLeaveDashboardTasks = async () => {
                for (const recipient of notifyRecipients) {
                    await upsertOperationalExpiryDashboardTask({
                        asset,
                        recipient,
                        requestType: 'Asset Leave',
                        kind: 'leave',
                        expiryDate,
                        daysLeft: diffDays,
                    });
                }
            };

            // Last day is today: email AC + owner (company email) + notification.
            if (diffDays === 0 && !asset.parkingDurationCompleteSentAt) {
                await sendParkingDurationCompleteEmail({
                    asset,
                    assignedEmployee,
                    assetController,
                    expiresToday: true,
                });
                await ensureLeaveDashboardTasks();

                await AssetHistory.create({
                    assetId: asset._id,
                    action: 'Comment',
                    performedBy: null,
                    comments: 'On Leave duration ends today. Notification sent to Asset Controller and assigned owner to Extend or mark On Duty.',
                    date: new Date(),
                    details: { auto: true, reason: 'LeaveDurationExpiryTodayNotification' }
                }).catch(() => null);

                asset.parkingDurationCompleteSentAt = new Date();
                await asset.save();
                continue;
            }

            // Overdue: notification bar only (no repeat email).
            if (diffDays < 0) {
                await ensureLeaveDashboardTasks();
                await asset.save();
            }
        }

        // Close stale leave expiry tasks when asset is no longer on leave.
        const staleLeaveTasks = await DashboardAction.find({
            requestType: 'Asset Leave',
            status: 'Pending',
            extra3: { $regex: '"focusCard"\\s*:\\s*"operationalExpiry"', $options: 'i' },
        })
            .select('requestId')
            .lean();

        for (const row of staleLeaveTasks) {
            const asset = await AssetItem.findById(row.requestId).select('onLeaveActive status').lean();
            if (!asset || asset.onLeaveActive !== true) {
                await DashboardAction.updateOne(
                    { _id: row._id },
                    {
                        $set: {
                            status: 'Approved',
                            actionedDate: new Date(),
                            comment: 'Asset no longer on leave.',
                        },
                    },
                );
            }
        }
    } catch (e) {
        console.error('[processParkingAssets] Non-fatal error:', e?.message || e);
    }
};
