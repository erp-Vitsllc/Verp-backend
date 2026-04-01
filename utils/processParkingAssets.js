import AssetItem from '../models/AssetItem.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import AssetHistory from '../models/AssetHistory.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { sendParkingReminderEmail, sendParkingExpiredEmail } from './sendAssetParkingNotifications.js';

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

            if (diffDays === 5 && !asset.parkingReminderSentAt) {
                await sendParkingReminderEmail({
                    asset,
                    assignedEmployee,
                    assetController,
                    daysLeft: 5
                });
                asset.parkingReminderSentAt = new Date();
                await asset.save();
            }

            if (diffDays <= 0) {
                asset.status = 'Unassigned';
                asset.assignedTo = null;
                asset.assignedBy = null;
                asset.assignmentType = null;
                asset.assignedDays = null;
                asset.acceptanceStatus = null;
                asset.actionRequiredBy = null;
                asset.negotiationHistory = [];
                asset.onLeaveStartDate = null;
                asset.onLeaveEndDate = null;
                asset.onLeaveDuration = null;
                asset.parkingExtendedDays = 0;
                asset.parkingReminderSentAt = null;
                await asset.save();

                await AssetHistory.create({
                    assetId: asset._id,
                    action: 'Returned',
                    performedBy: null,
                    comments: `Parking duration completed. Asset auto-moved to Unassigned.`,
                    date: new Date(),
                    details: { auto: true, reason: 'ParkingDurationCompleted' }
                });

                await sendParkingExpiredEmail({
                    asset,
                    assignedEmployee,
                    assetController
                });
            }
        }
    } catch (e) {
        console.error('[processParkingAssets] Non-fatal error:', e?.message || e);
    }
};
