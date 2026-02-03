import EmployeeBasic from "../../models/EmployeeBasic.js";
import { uploadDocumentToS3 } from "../../utils/s3Upload.js";
import mongoose from "mongoose";
import { resolveEmployeeId, getCompleteEmployee } from "../../services/employeeService.js";

// @desc    Update a document in employee's documents list
// @route   PATCH /api/Employee/:id/document/:index
// @access  Private
export const updateDocument = async (req, res) => {
    try {
        const { id, index } = req.params;
        const { type, description, expiryDate, document } = req.body;

        const resolved = await resolveEmployeeId(id);
        if (!resolved) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const employee = await EmployeeBasic.findById(resolved._id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }



        const docIndex = parseInt(index);
        if (isNaN(docIndex) || docIndex < 0 || !employee.documents || docIndex >= employee.documents.length) {
            return res.status(400).json({ message: "Invalid document index" });
        }

        // Update fields if provided
        if (type) employee.documents[docIndex].type = type;
        if (description) employee.documents[docIndex].description = description;
        if (expiryDate !== undefined) employee.documents[docIndex].expiryDate = expiryDate;

        if (document) {
            let documentData = null;

            // Check if it's new base64 data needing upload
            if (document.data && typeof document.data === 'string') {
                const folderPath = `employee-documents/${employee.employeeId}`;
                const uploadResult = await uploadDocumentToS3(
                    document.data,
                    folderPath,
                    document.name
                );

                documentData = {
                    name: document.name,
                    url: uploadResult.url,
                    mimeType: document.mimeType || 'application/pdf',
                    publicId: uploadResult.publicId
                };
            } else if (document.url) {
                // Existing or link
                documentData = {
                    name: document.name,
                    url: document.url,
                    mimeType: document.mimeType,
                    publicId: document.publicId
                };
            }

            if (documentData) {
                employee.documents[docIndex].document = documentData;
            }
        }

        const savedEmployee = await employee.save();
        const completeEmployee = await getCompleteEmployee(employee.employeeId);

        res.status(200).json({
            message: "Document updated successfully",
            employee: completeEmployee
        });

    } catch (error) {
        console.error("Error updating document:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};
