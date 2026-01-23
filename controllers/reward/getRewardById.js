import Reward from "../../models/Reward.js";

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
                .populate('approvedBy', 'name username')
                .populate('createdBy', 'name username')
                .populate('hrApprovedBy', 'name username')
                .populate('accountsApprovedBy', 'name username')
                .lean();
        }

        // If not found by ID or not an ObjectId, try finding by rewardId
        if (!reward) {
            reward = await Reward.findOne({ rewardId: searchId })
                .populate('approvedBy', 'name username')
                .populate('createdBy', 'name username')
                .populate('hrApprovedBy', 'name username')
                .populate('accountsApprovedBy', 'name username')
                .lean();
        }

        if (!reward) {
            return res.status(404).json({ message: "Reward not found" });
        }

        return res.status(200).json({
            message: "Reward fetched successfully",
            reward
        });
    } catch (error) {
        console.error('Error fetching reward:', error);

        return res.status(500).json({
            message: error.message || "Failed to fetch reward"
        });
    }
};













