import Loan from "../../models/Loan.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getDepartmentHOD } from "../../utils/getDepartmentHOD.js";
import { getManagementHOD } from "../../utils/getManagementHOD.js";
import { refreshStoredAttachmentUrls } from "../../utils/s3Upload.js";

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
                select: 'firstName lastName designation department employeeId'
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
                select: 'firstName lastName designation department employeeId'
            })
            .populate({
                path: 'hrApprovedBy',
                select: 'firstName lastName designation department employeeId'
            })
            .populate({
                path: 'accountsApprovedBy',
                select: 'firstName lastName designation department employeeId'
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

        // Visibility: Draft - only creator sees; Admin sees all
        const { isUserAdministrator } = await import('../../services/permissionService.js');
        const isAdmin = await isUserAdministrator(req.user?.id);
        const isCreator = loan.createdBy && (loan.createdBy._id?.toString() || loan.createdBy.toString()) === req.user?.id;
        if (!isAdmin && loan.status === 'Draft' && !isCreator) {
            return res.status(403).json({ message: "Access denied. Draft loans are visible only to the creator." });
        }

        // Format response
        const employee = loan.employeeObjectId || {};
        const hod = employee.primaryReportee || {};

        // Fetch current HODs for display fallbacks in tracker (Context Aware)
        // Passes the employee object ID to find THEIR company's specific responsibilities
        const hrHOD = await getDepartmentHOD('hr', employee._id);
        const accountsHOD = await getDepartmentHOD('finance', employee._id);

        const ceoHOD = await getManagementHOD(employee._id);

        if (Array.isArray(loan.approvalAttachments) && loan.approvalAttachments.length > 0) {
            await refreshStoredAttachmentUrls(loan.approvalAttachments);
        }
        if (Array.isArray(loan.approvalAttachmentHistory) && loan.approvalAttachmentHistory.length > 0) {
            await refreshStoredAttachmentUrls(loan.approvalAttachmentHistory);
        }

        const data = {
            _id: loan._id,
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
            monthStart: loan.monthStart, // Include monthStart for payment modal
            paidAmount: loan.paidAmount || 0, // Include paidAmount for payment tracking
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
            hrHODName: hrHOD ? `${hrHOD.firstName} ${hrHOD.lastName}` : 'Unknown',
            hrHODId: hrHOD ? hrHOD.employeeId : null,
            accountsHODName: accountsHOD ? `${accountsHOD.firstName} ${accountsHOD.lastName}` : 'Unknown',
            accountsHODId: accountsHOD ? accountsHOD.employeeId : null,
            ceoName: ceoHOD ? `${ceoHOD.firstName} ${ceoHOD.lastName}` : 'Unknown',
            ceoEmployeeId: ceoHOD ? ceoHOD.employeeId : null,
            createdBy: loan.createdBy,
            workflow: loan.workflow || [],
            approvalAttachments: loan.approvalAttachments || [],
            approvalAttachmentHistory: loan.approvalAttachmentHistory || [],
            originalMonthStart: loan.originalMonthStart,
            originalDuration: loan.originalDuration,
            rejectionReason: loan.rejectionReason,
            // Accounts party fields (Loan/Adv Parties card) — required for approve + Zoho payment
            zohoOrganizationId: loan.zohoOrganizationId || '',
            expenseAccountId: loan.expenseAccountId || '',
            expenseAccountName: loan.expenseAccountName || '',
            paidThroughAccountId: loan.paidThroughAccountId || '',
            paidThroughAccountName: loan.paidThroughAccountName || '',
            zohoJournalId: loan.zohoJournalId || '',
            zohoExpenseId: loan.zohoExpenseId || '',
            zohoExpenseNumber: loan.zohoExpenseNumber || '',
            zohoSyncedAt: loan.zohoSyncedAt || null,
            zohoSyncError: loan.zohoSyncError || '',
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
