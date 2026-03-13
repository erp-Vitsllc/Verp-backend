import Payment from "../../models/Payment.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";

export const getPayments = async (req, res) => {
    try {
        const {
            page = 1,
            limit = 1000,
            search = '',
            status,
            paymentType,
            startDate,
            endDate,
            employeeId,
            relatedEntityType,
            relatedEntityId,
            referenceId
        } = req.query;

        const query = {};

        // Search by payment ID, employee name, or payment type
        if (search) {
            query.$or = [
                { paymentId: { $regex: search, $options: 'i' } },
                { paidByName: { $regex: search, $options: 'i' } },
                { paymentType: { $regex: search, $options: 'i' } },
                { description: { $regex: search, $options: 'i' } }
            ];
        }

        if (status) query.status = status;
        if (paymentType) query.paymentType = paymentType;
        if (employeeId) query.paidBy = employeeId;
        
        // Filter by related entity (for fine/loan/advance)
        if (relatedEntityType) query.relatedEntityType = relatedEntityType;
        if (relatedEntityId) query.relatedEntityId = relatedEntityId;
        
        // Filter by referenceId (for fine ID or loan ID)
        if (referenceId) query.referenceId = referenceId;

        if (startDate || endDate) {
            query.paymentDate = {};
            if (startDate) query.paymentDate.$gte = new Date(startDate);
            if (endDate) query.paymentDate.$lte = new Date(endDate);
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const payments = await Payment.find(query)
            .populate('paidBy', 'employeeId firstName lastName')
            .populate('createdBy', 'firstName lastName')
            .populate('updatedBy', 'firstName lastName')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .lean();

        // Format payments with employee names
        const formattedPayments = payments.map(payment => {
            const paidByEmployee = payment.paidBy;
            return {
                ...payment,
                paidByName: payment.paidByName || 
                    (paidByEmployee ? `${paidByEmployee.firstName || ''} ${paidByEmployee.lastName || ''}`.trim() : 'N/A'),
                paidByEmployeeId: paidByEmployee?.employeeId || null
            };
        });

        const total = await Payment.countDocuments(query);

        res.status(200).json({
            success: true,
            payments: formattedPayments,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (error) {
        console.error('Error fetching payments:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to fetch payments'
        });
    }
};
