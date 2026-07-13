import Reward from "../../models/Reward.js";
import { getDepartmentHOD } from "../../utils/getDepartmentHOD.js";
import { getManagementHOD } from "../../utils/getManagementHOD.js";
import { getSignedFileUrl } from "../../utils/s3Upload.js";

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

        return res.status(200).json({
            message: "Reward fetched successfully",
            reward: {
                ...reward,
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
