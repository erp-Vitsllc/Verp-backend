import Payment from "../../models/Payment.js";
import {
    isReqUserAdmin,
    getManagementNotificationEmail,
} from "../../utils/sendAdminDeletionNotificationEmails.js";
import { awaitAdminDeletionArchive } from "../../utils/adminDeletionArchiveRun.js";

export const deletePayment = async (req, res) => {
    try {
        const isAdmin = await isReqUserAdmin(req.user);
        if (!isAdmin) {
            return res.status(403).json({
                success: false,
                message: 'Delete allowed only for admin.'
            });
        }

        const managementEmail = await getManagementNotificationEmail();
        if (!managementEmail) {
            return res.status(400).json({
                success: false,
                message: 'Cannot delete: no Management responsible person is assigned in Flowchart.'
            });
        }

        const { id } = req.params;

        const payment = await Payment.findById(id);

        if (!payment) {
            return res.status(404).json({
                success: false,
                message: 'Payment not found'
            });
        }

        const paymentSnapshot = payment.toObject ? payment.toObject() : payment;
        await awaitAdminDeletionArchive(req, {
            moduleName: 'Payment',
            recordId: payment.paymentId || payment._id?.toString?.(),
            details: payment.description || payment.referenceId || 'Payment record',
            deletedPayload: paymentSnapshot,
        });
        await Payment.findByIdAndDelete(id);

        res.status(200).json({
            success: true,
            message: 'Payment deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting payment:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete payment record'
        });
    }
};
