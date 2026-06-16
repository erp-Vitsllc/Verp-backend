import AssetItem from '../models/AssetItem.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import AssetHistory from '../models/AssetHistory.js';
import DashboardAction from '../models/DashboardAction.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import {
    sendParkingReminderEmail,
    sendLeaveAutoUnassignedEmail,
} from './sendAssetParkingNotifications.js';
import {
    applyLeaveExpiredAutoUnassign,
    onLeaveQueryFilter,
    ON_LEAVE_ADVANCE_NOTICE_DAYS,
} from './assetOperationalFlags.js';
import { upsertOperationalExpiryDashboardTask, completeOperationalExpiryDashboardTasks } from './upsertOperationalExpiryDashboardTask.js';

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

const loadEmployeeLean = async (id) => {
    if (!id) return null;
    return EmployeeBasic.findById(id)
        .select('firstName lastName employeeId companyEmail workEmail primaryReportee')
        .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail')
        .lean();
};

const collectLeaveNotifyParties = async (asset, assetController, assignedEmployee) => {
    const originalId =
        asset.onLeaveOriginalAssignee ||
        assignedEmployee?._id ||
        asset.assignedTo?._id ||
        asset.assignedTo;
    const packedId = asset.onLeavePackedTo;

    const [originalEmployee, packedCustodian] = await Promise.all([
        originalId && String(originalId) !== String(assignedEmployee?._id)
            ? loadEmployeeLean(originalId)
            : assignedEmployee,
        packedId ? loadEmployeeLean(packedId) : null,
    ]);

    const hod = originalEmployee?.primaryReportee || null;
    const parties = [originalEmployee, hod, packedCustodian, assetController].filter((p) => p?._id);

    const seen = new Set();
    return parties.filter((p) => {
        const key = String(p._id);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

export const processParkingAssets = async () => {
    try {
        const today = startOfDay(new Date());
        const assetController = await getDepartmentHOD('assetcontroller');

        const parkedAssets = await AssetItem.find({
            ...onLeaveQueryFilter(),
            onLeaveEndDate: { $ne: null },
        }).populate('assignedTo');

        for (const asset of parkedAssets) {
            if (!asset.onLeaveEndDate) continue;

            const diffDays = daysUntilLeaveEnd(asset.onLeaveEndDate, today);
            if (diffDays == null) continue;

            const assignedEmployee = await loadEmployeeLean(
                asset.onLeaveOriginalAssignee ||
                    asset.assignedTo?._id ||
                    asset.assignedTo,
            );

            const expiryDate = startOfDay(asset.onLeaveEndDate);
            const notifyRecipients = await collectLeaveNotifyParties(
                asset,
                assetController,
                assignedEmployee,
            );

            const ensureLeaveDashboardTasks = async (daysLeft) => {
                for (const recipient of notifyRecipients) {
                    await upsertOperationalExpiryDashboardTask({
                        asset,
                        recipient,
                        requestType: 'Asset Leave',
                        kind: 'leave',
                        expiryDate,
                        daysLeft,
                    });
                }
            };

            // 5 days before end: email + taskbar (not on the expiry day).
            if (diffDays === ON_LEAVE_ADVANCE_NOTICE_DAYS && !asset.parkingReminderSentAt) {
                await sendParkingReminderEmail({
                    asset,
                    assignedEmployee,
                    assetController,
                    hodEmployee: assignedEmployee?.primaryReportee || null,
                    packedCustodian: asset.onLeavePackedTo
                        ? await loadEmployeeLean(asset.onLeavePackedTo)
                        : null,
                    daysLeft: ON_LEAVE_ADVANCE_NOTICE_DAYS,
                });
                await ensureLeaveDashboardTasks(ON_LEAVE_ADVANCE_NOTICE_DAYS);

                await AssetHistory.create({
                    assetId: asset._id,
                    action: 'Comment',
                    performedBy: null,
                    comments: `On Leave duration reminder: ${ON_LEAVE_ADVANCE_NOTICE_DAYS} days remaining. Notification sent to owner, custodian, and Asset Controller.`,
                    date: new Date(),
                    details: { auto: true, reason: 'LeaveAdvanceNotice', daysLeft: ON_LEAVE_ADVANCE_NOTICE_DAYS },
                }).catch(() => null);

                asset.parkingReminderSentAt = new Date();
                await asset.save();
                continue;
            }

            // Past end date: auto-unassign to controller pool + email all parties (once).
            if (diffDays < 0 && !asset.parkingDurationCompleteSentAt) {
                const prevAssignee = asset.assignedTo?._id || asset.assignedTo;
                const packedRole = asset.onLeavePackedToRole;

                applyLeaveExpiredAutoUnassign(asset);

                await sendLeaveAutoUnassignedEmail({
                    asset,
                    parties: notifyRecipients,
                    packedRole,
                });

                await completeOperationalExpiryDashboardTasks(asset._id, ['leave']);

                await AssetHistory.create({
                    assetId: asset._id,
                    action: 'Unassigned',
                    assignedTo: prevAssignee || undefined,
                    performedBy: null,
                    comments:
                        'On Leave duration expired (max 40 days total). Asset automatically moved to Unassigned for Asset Controller.',
                    date: new Date(),
                    details: {
                        auto: true,
                        reason: 'LeaveDurationExpiredAutoUnassign',
                        packedRole: packedRole || null,
                    },
                }).catch(() => null);

                asset.parkingDurationCompleteSentAt = new Date();
                await asset.save();
                continue;
            }

            // Keep overdue taskbar rows updated without sending expiry-day alerts.
            if (diffDays < 0) {
                await ensureLeaveDashboardTasks(diffDays);
            }
        }

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
