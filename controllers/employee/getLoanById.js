import Loan from "../../models/Loan.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getDepartmentHOD } from "../../utils/getDepartmentHOD.js";

export const getLoanById = async (req, res) => {
    try {
        const { id } = req.params;

        const loan = await Loan.findById(id)
            .populate({
                path: 'employeeObjectId',
                select: 'firstName lastName department designation primaryReportee employeeId',
                populate: {
                    path: 'primaryReportee',
                    select: 'firstName lastName companyEmail email'
                }
            })
            .populate({
                path: 'approvedBy',
                select: 'firstName lastName designation department'
            })
            .populate({
                path: 'submittedTo',
                select: 'name'
            })
            .populate({
                path: 'workflow.assignedTo',
                select: 'name'
            })
            .populate({
                path: 'managerApprovedBy',
                select: 'firstName lastName designation department'
            })
            .populate({
                path: 'hrApprovedBy',
                select: 'firstName lastName designation department'
            })
            .populate({
                path: 'accountsApprovedBy',
                select: 'firstName lastName designation department'
            })
            .populate({
                path: 'rejectedBy',
                select: 'firstName lastName designation department'
            })
            .populate({
                path: 'createdBy',
                select: 'name'
            })
            .lean();

        if (!loan) {
            return res.status(404).json({ message: "Loan request not found" });
        }

        // Fetch current HODs for display fallbacks in tracker
        const hrHOD = await getDepartmentHOD('hr');
        const accountsHOD = await getDepartmentHOD('finance');

        // Format response
        const employee = loan.employeeObjectId || {};
        const hod = employee.primaryReportee || {};

        const data = {
            id: loan._id,
            loanId: loan.loanId || `LOAN-${loan._id.toString().slice(-6).toUpperCase()}`,
            applicantName: `${employee.firstName || ''} ${employee.lastName || ''}`.trim(),
            department: employee.department || 'N/A',
            designation: employee.designation || 'N/A',
            hodName: `${hod.firstName || ''} ${hod.lastName || ''}`.trim() || 'N/A',
            primaryReporteeEmail: hod.companyEmail || hod.email || null,
            employeeId: employee.employeeId, // Crucial for Edit/Pre-fill
            employeeObjectId: employee._id, // Adding MongoID just in case
            amount: loan.amount,
            reason: loan.reason,
            duration: loan.duration,
            type: loan.type,
            appliedDate: loan.appliedDate,
            status: loan.status,
            approvalStatus: loan.approvalStatus,
            createdAt: loan.createdAt,
            updatedAt: loan.updatedAt,
            approvedDate: loan.approvedDate,
            approvedBy: loan.approvedBy,
            submittedTo: loan.submittedTo,
            managerApprovedBy: loan.managerApprovedBy,
            hrApprovedBy: loan.hrApprovedBy,
            accountsApprovedBy: loan.accountsApprovedBy,
            hrHODName: hrHOD ? `${hrHOD.firstName} ${hrHOD.lastName}` : 'HR HOD',
            accountsHODName: accountsHOD ? `${accountsHOD.firstName} ${accountsHOD.lastName}` : 'Finance HOD',
            createdBy: loan.createdBy
        };

        res.status(200).json(data);

    } catch (error) {
        console.error("Error fetching loan details:", error);
        if (error.name === 'CastError') {
            return res.status(400).json({ message: "Invalid loan ID format" });
        }
        res.status(500).json({ message: "Failed to fetch loan details" });
    }
};
