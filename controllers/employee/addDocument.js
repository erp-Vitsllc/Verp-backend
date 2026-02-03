import EmployeeBasic from "../../models/EmployeeBasic.js";
import { uploadDocumentToS3 } from "../../utils/s3Upload.js";
import mongoose from "mongoose";
import { resolveEmployeeId, getCompleteEmployee } from "../../services/employeeService.js";

// @desc    Add a document to employee's documents list
// @route   POST /api/Employee/:id/document
// @access  Private
export const addDocument = async (req, res) => {
    try {
        const { id } = req.params;
        const { type, description, expiryDate, document } = req.body;

        const resolved = await resolveEmployeeId(id);
        if (!resolved) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const employee = await EmployeeBasic.findById(resolved._id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }



        let documentData = null;

        if (document) {
            // Check if it's base64 data needing upload
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
                    publicId: uploadResult.publicId // S3 Key
                };
            } else if (document.url) {
                // Already uploaded or just a link
                documentData = {
                    name: document.name,
                    url: document.url,
                    mimeType: document.mimeType,
                    publicId: document.publicId
                };
            }
        }

        const newDocument = {
            type,
            description,
            expiryDate, // Note: Schema might need update for this, but keeping it for compatibility
            document: documentData,
            createdAt: new Date()
        };

        if (!employee.documents) employee.documents = [];
        employee.documents.push(newDocument);

        const savedEmployee = await employee.save();
        const completeEmployee = await getCompleteEmployee(employee.employeeId);

        res.status(200).json({
            message: "Document added successfully",
            employee: completeEmployee
        });

    } catch (error) {
        console.error("Error adding document:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};
