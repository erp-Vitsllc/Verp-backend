import EmployeeBasic from "../../models/EmployeeBasic.js";
import { resolveEmployeeId, getCompleteEmployee } from "../../services/employeeService.js";
import {
    isReqUserAdmin,
    scheduleManagementAdminDeletionEmail,
} from "../../utils/sendAdminDeletionNotificationEmails.js";

// @desc    Delete a document from employee's oldDocuments list (Archive)
// @route   DELETE /api/Employee/:id/old-document/:target
// @access  Private (Admin Only)
export const deleteOldDocument = async (req, res) => {
    try {
        const isAdmin = await isReqUserAdmin(req.user);
        if (!isAdmin) {
            return res.status(403).json({ message: "Only administrator can delete archived employee documents." });
        }

        const { id, target } = req.params; // target can be an index or an _id
        const resolved = await resolveEmployeeId(id);
        if (!resolved) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const employee = await EmployeeBasic.findById(resolved._id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        if (!employee.oldDocuments || employee.oldDocuments.length === 0) {
            return res.status(404).json({ message: "No archived documents found" });
        }

        let docIndex = -1;

        // Try to treat target as an ID first (24-char hex string)
        if (target.match(/^[0-9a-fA-F]{24}$/)) {
            docIndex = employee.oldDocuments.findIndex(d => String(d._id || d.id) === target);
        }

        // If not found by ID, try treating it as an index
        if (docIndex === -1) {
            const indexValue = parseInt(target);
            if (!isNaN(indexValue) && indexValue >= 0 && indexValue < employee.oldDocuments.length) {
                docIndex = indexValue;
            }
        }

        if (docIndex === -1) {
            return res.status(400).json({ message: "Document not found in archive" });
        }

        const archivedDoc = employee.oldDocuments[docIndex];
        scheduleManagementAdminDeletionEmail(req, {
            moduleName: "Employee Old Document",
            recordId: employee.employeeId,
            details: (archivedDoc?.type || "Archived document").toString(),
            deletedPayload: { employeeId: employee.employeeId, document: archivedDoc },
        });

        // Remove document from oldDocuments array
        employee.oldDocuments.splice(docIndex, 1);
        await employee.save();

        const completeEmployee = await getCompleteEmployee(employee.employeeId);

        res.status(200).json({
            message: "Archived document deleted successfully",
            employee: completeEmployee
        });

    } catch (error) {
        console.error("Error deleting archived document:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};
