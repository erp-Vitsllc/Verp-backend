import Reward from "../../models/Reward.js";
import {
    isReqUserAdmin,
    scheduleManagementAdminDeletionEmail,
} from "../../utils/sendAdminDeletionNotificationEmails.js";

export const deleteReward = async (req, res) => {
    try {
        const isAdmin = await isReqUserAdmin(req.user);
        if (!isAdmin) {
            return res.status(403).json({ message: "Delete allowed only for admin." });
        }

        const { id } = req.params;

        const reward = await Reward.findById(id);
        if (!reward) {
            return res.status(404).json({ message: "Reward not found" });
        }

        const rewardSnapshot = reward.toObject ? reward.toObject() : reward;
        scheduleManagementAdminDeletionEmail(req, {
            moduleName: 'Reward',
            recordId: reward.rewardId || reward._id?.toString?.(),
            details: reward.title || reward.description || 'Reward record',
            deletedPayload: rewardSnapshot,
        });
        await Reward.findByIdAndDelete(id);

        return res.status(200).json({
            message: "Reward deleted successfully"
        });
    } catch (error) {
        console.error('Error deleting reward:', error);

        if (error.name === 'CastError') {
            return res.status(400).json({
                message: "Invalid reward ID"
            });
        }

        return res.status(500).json({
            message: error.message || "Failed to delete reward"
        });
    }
};

















