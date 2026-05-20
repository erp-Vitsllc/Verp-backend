import EmployeeBasic from "../../models/EmployeeBasic.js";
import mongoose from "mongoose";
import { resolveEmployeeId, getCompleteEmployee } from "../../services/employeeService.js";
import {
    isReqUserAdmin,
    scheduleManagementAdminDeletionEmail,
} from "../../utils/sendAdminDeletionNotificationEmails.js";
import { cleanupEmployeeExpiryNotificationsByLabels } from "../../utils/cleanupEmployeeExpiryNotifications.js";
import {
    documentStorageFingerprint,
    purgeEmployeeOldDocuments,
} from "../../utils/purgeEmployeeOldDocuments.js";

// @desc    Delete a document from employee's documents list
// @route   DELETE /api/Employee/:id/document/:index
// @access  Private
export const deleteDocument = async (req, res) => {
    try {
        const isAdmin = await isReqUserAdmin(req.user);
        if (!isAdmin) {
            return res.status(403).json({ message: "Only administrator can delete employee documents." });
        }

        const { id, index } = req.params;

        const resolved = await resolveEmployeeId(id);
        if (!resolved) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const employee = await EmployeeBasic.findById(resolved._id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }


        // Validate index
        const docIndex = parseInt(index);
        if (isNaN(docIndex) || docIndex < 0 || !employee.documents || docIndex >= employee.documents.length) {
            return res.status(400).json({ message: "Invalid document index" });
        }

        const documentToDelete = employee.documents[docIndex];
        const deletedDocLabel = (documentToDelete?.type || "Employee Document").toString().trim();

        scheduleManagementAdminDeletionEmail(req, {
            moduleName: "Employee Document",
            recordId: employee.employeeId,
            details: `${deletedDocLabel} (live document index ${docIndex})`,
            deletedPayload: {
                employeeId: employee.employeeId,
                document: documentToDelete,
            },
        });

        // Admin delete: remove from live documents only — do not copy to oldDocuments.
        employee.documents.splice(docIndex, 1);
        await employee.save();

        await purgeEmployeeOldDocuments(employee.employeeId, {
            types: [deletedDocLabel],
            documentFingerprints: [documentStorageFingerprint(documentToDelete?.document)],
            purgeDeletedArchiveReason: true,
        });

        await cleanupEmployeeExpiryNotificationsByLabels({
            employeeObjectId: employee._id,
            labels: [deletedDocLabel],
        });
        
        const completeEmployee = await getCompleteEmployee(employee.employeeId);

        res.status(200).json({
            message: "Document deleted successfully",
            employee: completeEmployee
        });

    } catch (error) {
        console.error("Error deleting document:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};
