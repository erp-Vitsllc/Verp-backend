import Fine from "../../models/Fine.js";
import {
    isReqUserAdmin,
    notifyAdminDeletedBusinessRecordToManagement
} from "../../utils/sendAdminDeletionNotificationEmails.js";

export const deleteFine = async (req, res) => {
    try {
        const isAdmin = await isReqUserAdmin(req.user);
        if (!isAdmin) {
            return res.status(403).json({ message: "Delete allowed only for admin." });
        }

        const { id } = req.params;
        const fine = await Fine.findById(id);

        if (!fine) {
            return res.status(404).json({ message: "Fine not found" });
        }

        await Fine.findByIdAndDelete(id);
        await notifyAdminDeletedBusinessRecordToManagement(req, {
            moduleName: 'Fine',
            recordId: fine.fineId || fine._id?.toString?.(),
            details: fine.description || fine.fineType || 'Fine transaction'
        });
        return res.status(200).json({ message: "Fine record deleted successfully" });
    } catch (error) {
        console.error('Error deleting fine:', error);
        return res.status(500).json({
            message: "Failed to delete fine record",
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};
