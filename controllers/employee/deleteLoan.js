import Loan from "../../models/Loan.js";
import {
    isReqUserAdmin,
    getManagementNotificationEmail,
    notifyAdminDeletedBusinessRecordToManagement
} from "../../utils/sendAdminDeletionNotificationEmails.js";

export const deleteLoan = async (req, res) => {
    try {
        const isAdmin = await isReqUserAdmin(req.user);
        if (!isAdmin) {
            return res.status(403).json({ message: "Delete allowed only for admin." });
        }

        const managementEmail = await getManagementNotificationEmail();
        if (!managementEmail) {
            return res.status(400).json({
                message: "Cannot delete: no Management responsible person is assigned in Flowchart."
            });
        }

        const { id } = req.params;

        const loan = await Loan.findById(id);
        if (!loan) {
            return res.status(404).json({ message: "Loan/Advance not found" });
        }

        // Strict Deletion Policy - Only non-active records can be deleted.
        if (!['Draft', 'Cancelled', 'Rejected'].includes(loan.status)) {
            return res.status(400).json({
                message: `Cannot delete record with '${loan.status}' status. ONLY 'Draft', 'Cancelled', or 'Rejected' records can be deleted.`
            });
        }

        await Loan.findByIdAndDelete(id);
        await notifyAdminDeletedBusinessRecordToManagement(req, {
            moduleName: loan.type || 'Loan/Advance',
            recordId: loan.loanId || loan._id?.toString?.(),
            details: loan.reason || loan.notes || `${loan.type || 'Loan/Advance'} record`
        });

        return res.status(200).json({
            message: `${loan.type} deleted successfully`
        });
    } catch (error) {
        console.error("Error in deleteLoan:", error);
        return res.status(500).json({ message: error.message || "Failed to delete loan/advance" });
    }
};
