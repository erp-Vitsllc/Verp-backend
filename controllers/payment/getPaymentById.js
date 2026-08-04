import mongoose from 'mongoose';
import Payment from '../../models/Payment.js';

/**
 * GET /Payment/:id — by Mongo _id or business paymentId (e.g. PAY-000123).
 * Used by the standalone payment receipt / invoice page.
 */
export const getPaymentById = async (req, res) => {
    try {
        const id = String(req.params.id || '').trim();
        if (!id) {
            return res.status(400).json({
                success: false,
                message: 'Payment id is required',
            });
        }

        const or = [{ paymentId: id }];
        if (mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === id) {
            or.push({ _id: id });
        }

        const payment = await Payment.findOne({ $or: or })
            .populate('paidBy', 'employeeId firstName lastName')
            .populate('createdBy', 'firstName lastName')
            .populate('updatedBy', 'firstName lastName')
            .lean();

        if (!payment) {
            return res.status(404).json({
                success: false,
                message: 'Payment receipt not found.',
            });
        }

        const paidByEmployee = payment.paidBy;
        const formatted = {
            ...payment,
            paidByName:
                payment.paidByName ||
                (paidByEmployee
                    ? `${paidByEmployee.firstName || ''} ${paidByEmployee.lastName || ''}`.trim()
                    : 'N/A'),
            paidByEmployeeId: paidByEmployee?.employeeId || null,
        };

        return res.status(200).json({
            success: true,
            payment: formatted,
        });
    } catch (error) {
        console.error('Error fetching payment by id:', error);
        return res.status(500).json({
            success: false,
            message: error.message || 'Failed to fetch payment',
        });
    }
};
