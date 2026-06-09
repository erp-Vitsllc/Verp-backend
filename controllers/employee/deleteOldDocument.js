import EmployeeBasic from "../../models/EmployeeBasic.js";
import { resolveEmployeeId, getEmployeeOldDocumentsForClient } from "../../services/employeeService.js";
import { isReqUserAdmin, scheduleManagementAdminDeletionEmail } from "../../utils/sendAdminDeletionNotificationEmails.js";

// @desc    Delete a document from employee's oldDocuments list (Archive)
// @route   DELETE /api/Employee/:id/old-document/:target
// @access  Private (Admin Only)
export const deleteOldDocument = async (req, res) => {
    try {
        const isAdmin = await isReqUserAdmin(req.user);
        if (!isAdmin) {
            return res.status(403).json({ message: "Only administrator can delete archived employee documents." });
        }

        const { id, target } = req.params;
        const resolved = await resolveEmployeeId(id);
        if (!resolved) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const employee = await EmployeeBasic.findById(resolved._id).select("employeeId oldDocuments");
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        if (!employee.oldDocuments || employee.oldDocuments.length === 0) {
            return res.status(404).json({ message: "No archived documents found" });
        }

        let docIndex = -1;

        if (target.match(/^[0-9a-fA-F]{24}$/)) {
            docIndex = employee.oldDocuments.findIndex((d) => String(d._id || d.id) === target);
        }

        if (docIndex === -1) {
            const indexValue = parseInt(target, 10);
            if (!isNaN(indexValue) && indexValue >= 0 && indexValue < employee.oldDocuments.length) {
                docIndex = indexValue;
            }
        }

        if (docIndex === -1) {
            return res.status(400).json({ message: "Document not found in archive" });
        }

        const archivedDoc = employee.oldDocuments[docIndex];
        const archivedId = archivedDoc?._id;

        scheduleManagementAdminDeletionEmail(req, {
            moduleName: "Employee Old Document",
            recordId: employee.employeeId,
            details: (archivedDoc?.type || "Archived document").toString(),
            deletedPayload: { employeeId: employee.employeeId, document: archivedDoc },
        });

        if (archivedId) {
            await EmployeeBasic.updateOne(
                { _id: resolved._id },
                { $pull: { oldDocuments: { _id: archivedId } } },
            );
        } else {
            employee.oldDocuments.splice(docIndex, 1);
            employee.markModified("oldDocuments");
            await employee.save();
        }

        const oldDocuments = await getEmployeeOldDocumentsForClient(employee.employeeId);

        res.status(200).json({
            message: "Archived document deleted successfully",
            oldDocuments,
        });
    } catch (error) {
        console.error("Error deleting archived document:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};
