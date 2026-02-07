import Reward from "../../models/Reward.js";

export const deleteReward = async (req, res) => {
    try {
        const { id } = req.params;

        const reward = await Reward.findById(id);
        if (!reward) {
            return res.status(404).json({ message: "Reward not found" });
        }

        // Strict Deletion Policy - Only 'Draft' records can be deleted.
        if (reward.rewardStatus !== 'Draft') {
            return res.status(400).json({
                message: `Cannot delete record with '${reward.rewardStatus}' status. ONLY 'Draft' records can be deleted.`
            });
        }

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















