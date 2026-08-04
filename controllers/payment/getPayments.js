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
            paidBy,
            relatedEntityType,
            relatedEntityId,
            referenceId,
            excludeRelatedEntityTypes,
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

        // paidBy / employeeId may be Mongo _id or business employeeId (e.g. VEGA-HR-0000)
        const paidByKey = String(paidBy || employeeId || '').trim();
        if (paidByKey) {
            let employee = null;
            if (/^[a-fA-F0-9]{24}$/.test(paidByKey)) {
                employee = await EmployeeBasic.findById(paidByKey).select('_id').lean();
            }
            if (!employee) {
                employee = await EmployeeBasic.findOne({ employeeId: paidByKey })
                    .select('_id')
                    .lean();
            }
            if (employee?._id) {
                query.paidBy = employee._id;
            } else {
                query.paidBy = paidByKey;
            }
        }
        
        // Filter by related entity (for fine/loan/advance).
        // When both relatedEntityId + referenceId are sent (loan repayments), match either
        // so individual loans stay isolated without missing alternate linkage styles.
        if (relatedEntityType) {
            query.relatedEntityType = relatedEntityType;
        } else if (excludeRelatedEntityTypes) {
            // Accounts ledger: hide Zoho Expense-Refund repayments (shown on loan detail instead).
            const excluded = String(excludeRelatedEntityTypes)
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            if (excluded.length) {
                query.relatedEntityType = { $nin: excluded };
            }
        }
        if (relatedEntityId && referenceId) {
            const entityOr = [
                { relatedEntityId },
                { referenceId },
            ];
            if (query.$or) {
                query.$and = [{ $or: query.$or }, { $or: entityOr }];
                delete query.$or;
            } else {
                query.$or = entityOr;
            }
        } else {
            if (relatedEntityId) query.relatedEntityId = relatedEntityId;
            if (referenceId) query.referenceId = referenceId;
        }

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
