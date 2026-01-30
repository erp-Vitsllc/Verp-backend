import Fine from "../../models/Fine.js";

export const deleteFine = async (req, res) => {
    try {
        const { id } = req.params;
        const fine = await Fine.findById(id);

        if (!fine) {
            return res.status(404).json({ message: "Fine not found" });
        }

        // Strict Deletion Policy - Only 'Draft' records can be deleted.
        // Once a record is Pending or further in the workflow, it cannot be deleted for audit purposes.
        if (fine.fineStatus !== 'Draft') {
            return res.status(400).json({
                message: `Cannot delete record with '${fine.fineStatus}' status. ONLY 'Draft' records can be deleted. Please cancel or reject active records instead.`
            });
        }

        await Fine.findByIdAndDelete(id);
        return res.status(200).json({ message: "Fine record deleted successfully" });
    } catch (error) {
        console.error('Error deleting fine:', error);
        return res.status(500).json({
            message: "Failed to delete fine record",
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};
