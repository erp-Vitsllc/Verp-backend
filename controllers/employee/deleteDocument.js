import EmployeeBasic from "../../models/EmployeeBasic.js";
import mongoose from "mongoose";
import { resolveEmployeeId, getCompleteEmployee } from "../../services/employeeService.js";
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";

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

        // Archive document before deleting from live list
        const documentToDelete = employee.documents[docIndex];
        if (documentToDelete) {
            if (!employee.oldDocuments) employee.oldDocuments = [];
            employee.oldDocuments.push({
                type: documentToDelete.type || '',
                description: documentToDelete.description || '',
                issueDate: documentToDelete.issueDate || null,
                expiryDate: documentToDelete.expiryDate || null,
                cost: documentToDelete.cost ?? null,
                basicSalary: documentToDelete.basicSalary ?? null,
                houseRentAllowance: documentToDelete.houseRentAllowance ?? null,
                vehicleAllowance: documentToDelete.vehicleAllowance ?? null,
                fuelAllowance: documentToDelete.fuelAllowance ?? null,
                otherAllowance: documentToDelete.otherAllowance ?? null,
                totalSalary: documentToDelete.totalSalary ?? null,
                createdAt: documentToDelete.createdAt || null,
                archivedAt: new Date(),
                archiveReason: 'Deleted',
                document: documentToDelete.document || null
            });
        }

        // Remove document from array
        employee.documents.splice(docIndex, 1);

        const savedEmployee = await employee.save();
        await triggerProfileReactivationIfNeeded({
            employeeId: employee.employeeId,
            actor: req.user,
            reason: "Document deleted",
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
