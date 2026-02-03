import EmployeeBasic from "../../models/EmployeeBasic.js";
import mongoose from "mongoose";
import { resolveEmployeeId, getCompleteEmployee } from "../../services/employeeService.js";

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


        // Validate index
        const docIndex = parseInt(index);
        if (isNaN(docIndex) || docIndex < 0 || !employee.documents || docIndex >= employee.documents.length) {
            return res.status(400).json({ message: "Invalid document index" });
        }

        // Get document to be deleted (optional: for logging or cleanup)
        // const documentToDelete = employee.documents[docIndex];

        // Remove document from array
        employee.documents.splice(docIndex, 1);

        const savedEmployee = await employee.save();
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
