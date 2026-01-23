import Reward from "../../models/Reward.js";

export const deleteReward = async (req, res) => {
    try {
        const { id } = req.params;

        const reward = await Reward.findById(id);
        if (!reward) {
            return res.status(404).json({ message: "Reward not found" });
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













