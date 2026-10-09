import AssetItem from '../models/AssetItem.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import AssetHistory from '../models/AssetHistory.js';
import DashboardAction from '../models/DashboardAction.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import {
    sendParkingReminderEmail,
    sendLeaveAutoUnassignedEmail,
    sendToolsLeaveCompleteEmail,
} from './sendAssetParkingNotifications.js';
import {
    applyLeaveExpiredAutoUnassign,
    onLeaveQueryFilter,
    ON_LEAVE_ADVANCE_NOTICE_DAYS,
} from './assetOperationalFlags.js';
import { isFleetVehicleAsset } from './assetApprovalHelpers.js';
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

const personName = (person) =>
    `${person?.firstName || ''} ${person?.lastName || ''}`.trim();

const loadEmployeeLean = async (id) => {
    if (!id) return null;
    return EmployeeBasic.findById(id)
        .select('firstName lastName employeeId companyEmail workEmail primaryReportee status profileStatus')
        .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail status profileStatus')
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
        })
            .populate('assignedTo')
            .populate('typeId', 'name');

        const dueLeaveReminders = [];
        const advanceTaskRows = [];
        const taskHoldersByAsset = new Map();

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
            const taskRecipients = [assignedEmployee, assetController].filter((person) => person?._id);
            const holderIds = new Set(taskRecipients.map((person) => String(person._id)));
            taskHoldersByAsset.set(String(asset._id), holderIds);
            const ownerLabel = personName(assignedEmployee);

            const ensureLeaveDashboardTasks = async (daysLeft) => {
                const seen = new Set();
                for (const recipient of taskRecipients) {
                    const recipientKey = String(recipient._id);
                    if (seen.has(recipientKey)) continue;
                    seen.add(recipientKey);
                    await upsertOperationalExpiryDashboardTask({
                        asset,
                        recipient,
                        requestType: 'Asset Leave',
                        kind: 'leave',
                        expiryDate,
                        daysLeft,
                        subjectName: ownerLabel,
                    });
                }
            };

            const holdAdvanceTask =
                diffDays >= 0 &&
                (diffDays === ON_LEAVE_ADVANCE_NOTICE_DAYS || !!asset.parkingReminderSentAt);
            if (holdAdvanceTask) {
                advanceTaskRows.push({ asset, assignedEmployee, expiryDate, taskRecipients, ownerLabel });
            }

            // 5 days before end: collect, then one email per employee (not on the expiry day).
            if (diffDays === ON_LEAVE_ADVANCE_NOTICE_DAYS && !asset.parkingReminderSentAt) {
                dueLeaveReminders.push({ asset, assignedEmployee, expiryDate });
                continue;
            }

            // Tools: after the leave end date, keep the assignment. Email and bell the Asset Controller.
            // Leave cannot be extended. The controller can reassign the asset to another employee.
            if (diffDays < 0 && !isFleetVehicleAsset(asset)) {
                if (!asset.parkingDurationCompleteSentAt) {
                    await sendToolsLeaveCompleteEmail({ asset, assetController });
                    await DashboardAction.updateMany(
                        {
                            requestId: asset._id,
                            status: 'Pending',
                            requestType: 'Asset Leave',
                            extra3: { $regex: '"kind"\\s*:\\s*"leave"(?!Complete)', $options: 'i' },
                        },
                        {
                            $set: {
                                status: 'Approved',
                                actionedDate: new Date(),
                                comment: 'Leave duration is complete.',
                            },
                        },
                    );
                    await AssetHistory.create({
                        assetId: asset._id,
                        action: 'Comment',
                        assignedTo: asset.assignedTo?._id || asset.assignedTo || undefined,
                        performedBy: null,
                        comments:
                            'On Leave duration is complete. Leave cannot be extended. Asset stays assigned. Asset Controller can reassign it to another employee.',
                        date: new Date(),
                        details: { auto: true, reason: 'ToolsLeaveComplete' },
                    }).catch(() => null);
                    asset.parkingDurationCompleteSentAt = new Date();
                    await asset.save();
                }

                if (assetController?._id) {
                    taskHoldersByAsset.set(String(asset._id), new Set([String(assetController._id)]));
                    await upsertOperationalExpiryDashboardTask({
                        asset,
                        recipient: assetController,
                        requestType: 'Asset Leave',
                        kind: 'leaveComplete',
                        expiryDate,
                        daysLeft: diffDays,
                        subjectName: ownerLabel,
                    });
                } else {
                    taskHoldersByAsset.set(String(asset._id), new Set());
                }
                continue;
            }

            // Fleet vehicles: past end date, auto-unassign to controller pool + email all parties (once).
            if (diffDays < 0 && !asset.parkingDurationCompleteSentAt) {
                const prevAssignee = asset.assignedTo?._id || asset.assignedTo;
                const packedRole = asset.onLeavePackedToRole;

                applyLeaveExpiredAutoUnassign(asset);
                taskHoldersByAsset.delete(String(asset._id));

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

        const remindersByEmployee = new Map();
        for (const row of dueLeaveReminders) {
            const key = row.assignedEmployee?._id ? String(row.assignedEmployee._id) : 'unassigned';
            if (!remindersByEmployee.has(key)) remindersByEmployee.set(key, []);
            remindersByEmployee.get(key).push(row);
        }

        for (const rows of remindersByEmployee.values()) {
            const assignedEmployee = rows[0].assignedEmployee || null;
            await sendParkingReminderEmail({
                assets: rows.map((row) => row.asset),
                assignedEmployee,
                assetController,
                hodEmployee: assignedEmployee?.primaryReportee || null,
                daysLeft: ON_LEAVE_ADVANCE_NOTICE_DAYS,
            });

            for (const row of rows) {
                await AssetHistory.create({
                    assetId: row.asset._id,
                    action: 'Comment',
                    performedBy: null,
                    comments: `On Leave duration reminder: ${ON_LEAVE_ADVANCE_NOTICE_DAYS} days remaining. One email to Asset Controller, assigned employee, and primary reportee. Task for assigned employee and Asset Controller only.`,
                    date: new Date(),
                    details: { auto: true, reason: 'LeaveAdvanceNotice', daysLeft: ON_LEAVE_ADVANCE_NOTICE_DAYS },
                }).catch(() => null);

                row.asset.parkingReminderSentAt = new Date();
                await row.asset.save();
            }
        }

        const seenAdvanceTasks = new Set();
        for (const row of advanceTaskRows) {
            for (const recipient of row.taskRecipients) {
                const recipientKey = `${row.asset._id}:${recipient._id}`;
                if (seenAdvanceTasks.has(recipientKey)) continue;
                seenAdvanceTasks.add(recipientKey);
                await upsertOperationalExpiryDashboardTask({
                    asset: row.asset,
                    recipient,
                    requestType: 'Asset Leave',
                    kind: 'leave',
                    expiryDate: row.expiryDate,
                    daysLeft: ON_LEAVE_ADVANCE_NOTICE_DAYS,
                    subjectName: row.ownerLabel,
                });
            }
        }

        const staleLeaveTasks = await DashboardAction.find({
            requestType: 'Asset Leave',
            status: 'Pending',
            extra3: { $regex: '"focusCard"\\s*:\\s*"operationalExpiry"', $options: 'i' },
        })
            .select('requestId assignedTo')
            .lean();

        for (const row of staleLeaveTasks) {
            const assetId = String(row.requestId || '');
            const holders = taskHoldersByAsset.get(assetId);
            const assigneeId = String(row.assignedTo || '');
            if (holders && holders.has(assigneeId)) continue;

            const asset = holders
                ? { onLeaveActive: true }
                : await AssetItem.findById(row.requestId).select('onLeaveActive status').lean();
            const wrongHolder = holders && !holders.has(assigneeId);
            const noLongerOnLeave = !asset || asset.onLeaveActive !== true;
            if (!wrongHolder && !noLongerOnLeave) continue;

            await DashboardAction.updateOne(
                { _id: row._id },
                {
                    $set: {
                        status: 'Approved',
                        actionedDate: new Date(),
                        comment: wrongHolder
                            ? 'On Leave task is only for the assigned employee and Asset Controller.'
                            : 'Asset no longer on leave.',
                    },
                },
            );
        }
    } catch (e) {
        console.error('[processParkingAssets] Non-fatal error:', e?.message || e);
    }
};
