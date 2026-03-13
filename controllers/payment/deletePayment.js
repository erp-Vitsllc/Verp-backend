import Payment from "../../models/Payment.js";

export const deletePayment = async (req, res) => {
    try {
        const { id } = req.params;

        const payment = await Payment.findById(id);

        if (!payment) {
            return res.status(404).json({
                success: false,
                message: 'Payment not found'
            });
        }

        await Payment.findByIdAndDelete(id);

        res.status(200).json({
            success: true,
            message: 'Payment deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting payment:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to delete payment'
        });
    }
};
