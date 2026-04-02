import AssetItem from '../models/AssetItem.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import Company from '../models/Company.js';
import AssetHistory from '../models/AssetHistory.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { sendTemporaryAssignmentReminderEmail, sendTemporaryAssignmentExpiredEmail } from './sendTemporaryAssignmentEmails.js';

const startOfDay = (d) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
};

const daysLeft = (endDate, today) => {
    if (!endDate) return null;
    const end = startOfDay(endDate);
    const diffMs = end - today;
    return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
};

export const processTemporaryAssignments = async () => {
    try {
        const today = startOfDay(new Date());

        const [assetController, hrHOD] = await Promise.all([
            getDepartmentHOD('assetcontroller'),
            getDepartmentHOD('hr')
        ]);

        const assets = await AssetItem.find({
            status: 'Assigned',
            assignmentType: 'Temporary',
            temporaryEndDate: { $ne: null }
        }).populate('assignedTo assignedCompany');

        for (const asset of assets) {
            if (!asset.temporaryEndDate) continue;
            const dLeft = daysLeft(asset.temporaryEndDate, today);
            if (dLeft == null) continue;

            // Prepare assignee docs
            let assigneeEmployee = null;
            let assigneeCompany = null;
            if (asset.assignedToType === 'Employee') {
                assigneeEmployee = asset.assignedTo || (asset.assignedTo?._id ? asset.assignedTo : null);
                if (!assigneeEmployee) continue;
            } else if (asset.assignedToType === 'Company') {
                assigneeCompany = asset.assignedCompany || null;
                if (!assigneeCompany && asset.assignedCompany?._id) {
                    assigneeCompany = await Company.findById(asset.assignedCompany._id);
                }
            }

            if (dLeft === 5 && !asset.temporaryReminderSentAt) {
                if (!assetController || !hrHOD) {
                    // still mark to prevent repeated errors
                    continue;
                }

                await sendTemporaryAssignmentReminderEmail({
                    asset,
                    assigneeEmployee,
                    assigneeCompany,
                    assetController,
                    hrHOD,
                    endDate: asset.temporaryEndDate,
                    daysLeft: dLeft
                });

                asset.temporaryReminderSentAt = new Date();
                await asset.save();
            }

            if (dLeft <= 0 && !asset.temporaryExpiredSentAt) {
                if (!assetController || !hrHOD) continue;

                // Auto-unassign
                const prevAssignedTo = asset.assignedTo;
                const prevAssignedCompany = asset.assignedCompany;

                await sendTemporaryAssignmentExpiredEmail({
                    asset,
                    assigneeEmployee,
                    assigneeCompany,
                    assetController,
                    hrHOD,
                    endDate: asset.temporaryEndDate
                });

                asset.status = 'Unassigned';
                asset.assignedTo = null;
                asset.assignedCompany = null;
                // Keep UI consistent: if assignedToType stays "Company", UI may show "Company Assigned".
                asset.assignedToType = 'Employee';
                asset.assignedBy = null;
                asset.assignmentType = null;
                asset.assignedDays = null;
                asset.assignedDate = null;
                asset.temporaryEndDate = null;
                asset.temporaryReminderSentAt = null;
                asset.temporaryExpiredSentAt = new Date();
                asset.acceptanceStatus = null;
                asset.actionRequiredBy = null;
                asset.negotiationHistory = [];

                await asset.save();

                await AssetHistory.create({
                    assetId: asset._id,
                    action: 'Returned',
                    performedBy: null,
                    comments: `Temporary assignment expired. Asset moved to Unassigned (auto).`,
                    date: new Date(),
                    details: { auto: true, reason: 'TemporaryAssignmentExpired', prevAssignedTo, prevAssignedCompany }
                });
            }
        }
    } catch (e) {
        console.error('[processTemporaryAssignments] Non-fatal:', e?.message || e);
    }
};

