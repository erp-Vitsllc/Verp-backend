import Loan from "../../models/Loan.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";
import { awaitAdminDeletionArchive } from "../../utils/adminDeletionArchiveRun.js";

export const deleteLoan = async (req, res) => {
    try {
        const isAdmin = await isReqUserAdmin(req.user);
        if (!isAdmin) {
            return res.status(403).json({ message: "Delete allowed only for admin." });
        }

        const { id } = req.params;

        const loan = await Loan.findById(id);
        if (!loan) {
            return res.status(404).json({ message: "Loan/Advance not found" });
        }

        const loanSnapshot = loan.toObject ? loan.toObject() : loan;
        await awaitAdminDeletionArchive(req, {
            moduleName: loan.type || 'Loan/Advance',
            recordId: loan.loanId || loan._id?.toString?.(),
            details: loan.reason || loan.notes || `${loan.type || 'Loan/Advance'} record`,
            deletedPayload: loanSnapshot,
        });
        await Loan.findByIdAndDelete(id);

        return res.status(200).json({
            message: `${loan.type} deleted successfully`
        });
    } catch (error) {
        console.error("Error in deleteLoan:", error);
        return res.status(500).json({ message: error.message || "Failed to delete loan/advance" });
    }
};
