import AssetItem from '../models/AssetItem.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import AssetHistory from '../models/AssetHistory.js';
import DashboardAction from '../models/DashboardAction.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { sendParkingReminderEmail } from './sendAssetParkingNotifications.js';

const startOfDay = (d) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
};

export const processParkingAssets = async () => {
    try {
        const today = startOfDay(new Date());
        const assetController = await getDepartmentHOD('assetcontroller');

        const parkedAssets = await AssetItem.find({
            status: 'On Leave',
            onLeaveEndDate: { $ne: null },
            assignedTo: { $ne: null }
        }).populate('assignedTo');

        for (const asset of parkedAssets) {
            if (!asset.onLeaveEndDate || !asset.assignedTo) continue;

            const endDate = startOfDay(asset.onLeaveEndDate);
            const diffDays = Math.ceil((endDate - today) / (1000 * 60 * 60 * 24));

            const assignedEmployee = await EmployeeBasic.findById(asset.assignedTo._id || asset.assignedTo)
                .select('firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee')
                .populate('primaryReportee', 'firstName lastName companyEmail workEmail personalEmail email')
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

            if (diffDays <= 0 && !asset.parkingDurationCompleteSentAt) {
                if (assetController?._id) {
                    await DashboardAction.create({
                        assignedTo: assetController._id,
                        assignedToEmpId: assetController.employeeId,
                        requestId: asset._id,
                        requestType: 'Asset Leave',
                        subjectEmployeeId: assignedEmployee?.employeeId || asset.assetId,
                        subjectName: `${assignedEmployee?.firstName || ''} ${assignedEmployee?.lastName || ''}`.trim() || 'Assigned Employee',
                        requestedByName: 'System Monitor',
                        extra1: `${asset.assetId} - ${asset.name}`,
                        extra2: 'Parking duration completed. Please Extend or Return.',
                        status: 'Pending'
                    }).catch((e) => {
                        console.error('[processParkingAssets] Failed creating expiry notification:', e?.message || e);
                    });
                }
                await AssetHistory.create({
                    assetId: asset._id,
                    action: 'Comment',
                    performedBy: null,
                    comments: `Parking duration completed. Notification sent to seek Extend or Return action.`,
                    date: new Date(),
                    details: { auto: true, reason: 'ParkingDurationCompletedNotification' }
                });
                asset.parkingDurationCompleteSentAt = new Date();
                await asset.save();
            }
        }
    } catch (e) {
        console.error('[processParkingAssets] Non-fatal error:', e?.message || e);
    }
};
