import Loan from "../../models/Loan.js";
import mongoose from "mongoose";
import { isUserAdministrator } from "../../services/permissionService.js";

export const getLoans = async (req, res) => {
    try {
        const { type, employeeId } = req.query; // Optional filter by type and employeeId
        const query = {};
        if (type && ['Loan', 'Advance'].includes(type)) {
            query.type = type;
        }
        if (employeeId) {
            query.employeeId = employeeId;
        }

        // Visibility: Draft - only creator sees; Pending+ - everyone. Admin sees all.
        const isAdmin = await isUserAdministrator(req.user?.id);
        if (!isAdmin && req.user?.id) {
            query.$and = query.$and || [];
            query.$and.push({
                $or: [
                    { status: { $ne: 'Draft' } },
                    { createdBy: new mongoose.Types.ObjectId(req.user.id) }
                ]
            });
        }

        const loans = await Loan.find(query)
            .sort({ createdAt: -1 })
            .populate('employeeObjectId', 'firstName lastName')
            .lean();

        // Transform data if needed
        const formattedLoans = loans.map(loan => ({
            id: loan._id,
            _id: loan._id, // Include _id for compatibility
            loanId: loan.loanId, // Expose the sequential ID
            employeeId: loan.employeeId,
            employeeName: loan.employeeObjectId ? `${loan.employeeObjectId.firstName} ${loan.employeeObjectId.lastName}` : 'N/A',
            type: loan.type,
            amount: loan.amount,
            duration: loan.duration, // Include duration for payment modal
            monthStart: loan.monthStart, // Include monthStart for payment modal
            paidAmount: loan.paidAmount || 0, // Include paidAmount for payment tracking
            status: loan.status, // Using 'status' field from model but user distincts 'advance Status' vs 'Application Status'.
            // Based on model 'status' and 'approvalStatus' are both Pending/Approved/Rejected.
            // I'll return both.
            approvalStatus: loan.approvalStatus || loan.status, // Include approvalStatus for compatibility
            applicationStatus: loan.approvalStatus || loan.status,
            activeStatus: (loan.approvalStatus === 'Approved' || loan.status === 'Approved'
                || loan.approvalStatus === 'Pending Payment to Employee'
                || loan.status === 'Pending Payment to Employee'
                || loan.approvalStatus === 'Paid' || loan.status === 'Paid')
                ? ((loan.approvalStatus === 'Paid' || loan.status === 'Paid') ? 'Closed' : 'Open')
                : (loan.approvalStatus === 'Rejected' || loan.status === 'Rejected') ? 'Closed' : 'Pending',
            createdAt: loan.createdAt
        }));

        res.status(200).json({ loans: formattedLoans });

    } catch (error) {
        console.error("Error fetching loans:", error);
        res.status(500).json({ message: "Failed to fetch loans" });
    }
};
