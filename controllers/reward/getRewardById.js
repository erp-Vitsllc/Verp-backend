import Reward from "../../models/Reward.js";
import { getDepartmentHOD } from "../../utils/getDepartmentHOD.js";
import { getManagementHOD } from "../../utils/getManagementHOD.js";
import { getSignedFileUrl } from "../../utils/s3Upload.js";
import { attachZohoExpenseNumber } from "../../utils/attachZohoDocumentNumbers.js";

async function withFreshSignedUrl(fileMeta) {
    if (!fileMeta?.publicId) return fileMeta || null;
    try {
        const url = await getSignedFileUrl(fileMeta.publicId);
        if (!url) return fileMeta;
        return { ...fileMeta, url };
    } catch {
        return fileMeta;
    }
}

export const getRewardById = async (req, res) => {
    try {
        const { id } = req.params;

        // Custom URL handling: remove "rewrd." prefix if present
        let searchId = id;
        if (id && id.startsWith('rewrd.')) {
            searchId = id.split('rewrd.')[1];
        }

        let reward;
        const mongoose = await import('mongoose');
        const isValidObjectId = mongoose.Types.ObjectId.isValid(searchId);

        if (isValidObjectId) {
            reward = await Reward.findById(searchId)
                .populate('approvedBy', 'name username employeeId')
                .populate('createdBy', 'name username')
                .populate('hrApprovedBy', 'name username employeeId')
                .populate('accountsApprovedBy', 'name username employeeId')
                .populate('workflow.assignedTo', 'name username firstName lastName employeeId')
                .lean();
        }

        // If not found by ID or not an ObjectId, try finding by rewardId
        if (!reward) {
            reward = await Reward.findOne({ rewardId: searchId })
                .populate('approvedBy', 'name username employeeId')
                .populate('createdBy', 'name username')
                .populate('hrApprovedBy', 'name username employeeId')
                .populate('accountsApprovedBy', 'name username employeeId')
                .populate('workflow.assignedTo', 'name username firstName lastName employeeId')
                .lean();
        }

        if (!reward) {
            return res.status(404).json({ message: "Reward not found" });
        }

        // Heal inconsistent state: never keep Approved (Paid) without Zoho Expense
        const amount = parseFloat(reward.amount || 0) || 0;
        const isCashOrGift =
            reward.rewardType === 'Cash Reward' ||
            reward.rewardType === 'Gift Reward' ||
            amount > 0;
        const hasZoho = Boolean(
            String(reward.zohoExpenseId || '').trim() || String(reward.zohoJournalId || '').trim()
        );
        const status = String(reward.rewardStatus || '').trim();
        if (
            isCashOrGift &&
            !hasZoho &&
            (status === 'Approved (Paid)' || status === 'Paid')
        ) {
            try {
                await Reward.findByIdAndUpdate(reward._id, {
                    $set: {
                        rewardStatus: 'Pending Accounts',
                        approvalStatus: 'Pending Accounts',
                        paidAmount: 0,
                    },
                    $setOnInsert: {},
                });
                // Re-open Accounts workflow step if it was closed
                const doc = await Reward.findById(reward._id);
                if (doc?.workflow?.length) {
                    const accountsStep = doc.workflow.find((w) => w.role === 'Accounts');
                    if (accountsStep) {
                        accountsStep.status = 'Pending';
                        accountsStep.actionedAt = null;
                        await doc.save();
                    }
                }
                reward.rewardStatus = 'Pending Accounts';
                reward.approvalStatus = 'Pending Accounts';
                reward.paidAmount = 0;
                console.warn(
                    `[getRewardById] Healed ${reward.rewardId || reward._id}: Approved (Paid) without Zoho → Pending Accounts`,
                );
            } catch (healErr) {
                console.error('[getRewardById] Heal failed:', healErr);
            }
        }

        // Visibility: Draft - only creator sees; Admin sees all
        const { isUserAdministrator } = await import('../../services/permissionService.js');
        const isAdmin = await isUserAdministrator(req.user?.id);
        const isCreator = reward.createdBy && (reward.createdBy._id?.toString() || reward.createdBy.toString()) === req.user?.id;
        if (!isAdmin && reward.rewardStatus === 'Draft' && !isCreator) {
            return res.status(403).json({ message: "Access denied. Draft rewards are visible only to the creator." });
        }

        // Fetch HODs with context (Pass employeeId to resolve company)
        const hrHOD = await getDepartmentHOD('hr', reward.employeeId);
        const accountsHOD = await getDepartmentHOD('finance', reward.employeeId);
        const ceoHOD = await getManagementHOD(reward.employeeId);

        const [attachment, certificateAttachment] = await Promise.all([
            withFreshSignedUrl(reward.attachment),
            withFreshSignedUrl(reward.certificateAttachment),
        ]);

        const rewardWithZohoNo = await attachZohoExpenseNumber(reward, {
            persistModel: Reward,
            fetchLive: true,
        });

        return res.status(200).json({
            message: "Reward fetched successfully",
            reward: {
                ...rewardWithZohoNo,
                attachment,
                certificateAttachment,
                hrHODName: hrHOD ? `${hrHOD.firstName} ${hrHOD.lastName}` : 'Unknown',
                hrHODId: hrHOD ? hrHOD.employeeId : null,
                accountsHODName: accountsHOD ? `${accountsHOD.firstName} ${accountsHOD.lastName}` : 'Unknown',
                accountsHODId: accountsHOD ? accountsHOD.employeeId : null,
                ceoName: ceoHOD ? `${ceoHOD.firstName} ${ceoHOD.lastName}` : 'Unknown',
                ceoEmployeeId: ceoHOD ? ceoHOD.employeeId : null
            }
        });
    } catch (error) {
        console.error('Error fetching reward:', error);

        return res.status(500).json({
            message: error.message || "Failed to fetch reward"
        });
    }
};
