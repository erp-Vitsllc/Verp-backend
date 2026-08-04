import EmployeeBasic from "../../models/EmployeeBasic.js";
import mongoose from "mongoose";
import { resolveEmployeeId, getCompleteEmployee } from "../../services/employeeService.js";
import { disposeEmployeeProfileAttachment } from "../../utils/profileAttachmentDisposition.js";
import { denyEmployeeCardDeleteUnlessAllowed } from "../../utils/employeeCardDeleteAccess.js";
import { cleanupAllNotificationsForEmployeeCardDelete } from "../../utils/cleanupEmployeeExpiryNotifications.js";
import {
    documentStorageFingerprint,
    purgeEmployeeOldDocuments,
} from "../../utils/purgeEmployeeOldDocuments.js";
import { scheduleEmployeeProfileFileChangeHrEmailForRequest } from "../../utils/employeeInformativeHrNotify.js";

// @desc    Delete a document from employee's documents list
// @route   DELETE /api/Employee/:id/document/:index
// @access  Private
export const deleteDocument = async (req, res) => {
    try {
        const { id, index } = req.params;

        const resolved = await resolveEmployeeId(id);
        if (!resolved) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const employee = await EmployeeBasic.findById(resolved._id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const denied = await denyEmployeeCardDeleteUnlessAllowed(req, employee, "employee documents");
        if (denied) return res.status(denied.status).json(denied.body);

        // Validate index
        const docIndex = parseInt(index);
        if (isNaN(docIndex) || docIndex < 0 || !employee.documents || docIndex >= employee.documents.length) {
            return res.status(400).json({ message: "Invalid document index" });
        }

        const documentToDelete = employee.documents[docIndex];
        const deletedDocLabel = (documentToDelete?.type || "Employee Document").toString().trim();

        await disposeEmployeeProfileAttachment(req, {
            employeeBasic: employee,
            attachment: documentToDelete?.document,
            archive: {
                moduleName: "Employee Document",
                recordId: employee.employeeId,
                details: `${deletedDocLabel} (live document index ${docIndex})`,
                deletedPayload: {
                    employeeId: employee.employeeId,
                    document: documentToDelete,
                },
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

        await cleanupAllNotificationsForEmployeeCardDelete({
            employeeObjectId: employee._id,
            labels: [deletedDocLabel],
            cardLabels: [String(deletedDocLabel || "").toLowerCase()],
            notRenewKinds: ["manualDocument"],
            actionedBy: req.user?.employeeObjectId || null,
        });
        
        const completeEmployee = await getCompleteEmployee(employee.employeeId);

        scheduleEmployeeProfileFileChangeHrEmailForRequest({
            req,
            employeeId: employee.employeeId,
            sectionKey: "documents",
            sectionLabel: deletedDocLabel,
            action: "deleted",
            attachments: documentToDelete?.document,
            actor: req.user,
        });

        res.status(200).json({
            message: "Document deleted successfully",
            employee: completeEmployee
        });

    } catch (error) {
        console.error("Error deleting document:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};
