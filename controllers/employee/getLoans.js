import Loan from "../../models/Loan.js";

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

        const loans = await Loan.find(query)
            .sort({ createdAt: -1 })
            .populate('employeeObjectId', 'firstName lastName')
            .lean();

        // Transform data if needed
        const formattedLoans = loans.map(loan => ({
            id: loan._id,
            loanId: loan.loanId, // Expose the sequential ID
            employeeId: loan.employeeId,
            employeeName: loan.employeeObjectId ? `${loan.employeeObjectId.firstName} ${loan.employeeObjectId.lastName}` : 'N/A',
            type: loan.type,
            amount: loan.amount,
            status: loan.status, // Using 'status' field from model but user distincts 'advance Status' vs 'Application Status'.
            // Based on model 'status' and 'approvalStatus' are both Pending/Approved/Rejected.
            // I'll return both.
            applicationStatus: loan.approvalStatus || loan.status,
            activeStatus: (loan.approvalStatus === 'Approved' || loan.status === 'Approved') ? 'Open' :
                (loan.approvalStatus === 'Rejected' || loan.status === 'Rejected') ? 'Closed' : 'Pending',
            createdAt: loan.createdAt
        }));

        res.status(200).json({ loans: formattedLoans });

    } catch (error) {
        console.error("Error fetching loans:", error);
        res.status(500).json({ message: "Failed to fetch loans" });
    }
};
