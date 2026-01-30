import Loan from "../../models/Loan.js";

export const deleteLoan = async (req, res) => {
    try {
        const { id } = req.params;

        const loan = await Loan.findById(id);
        if (!loan) {
            return res.status(404).json({ message: "Loan/Advance not found" });
        }

        // Strict Deletion Policy - Only 'Draft' records can be deleted.
        if (loan.status !== 'Draft') {
            return res.status(400).json({
                message: `Cannot delete record with '${loan.status}' status. ONLY 'Draft' records can be deleted. Please cancel or reject active records instead.`
            });
        }

        await Loan.findByIdAndDelete(id);

        return res.status(200).json({
            message: `${loan.type} deleted successfully`
        });
    } catch (error) {
        console.error("Error in deleteLoan:", error);
        return res.status(500).json({ message: error.message || "Failed to delete loan/advance" });
    }
};
