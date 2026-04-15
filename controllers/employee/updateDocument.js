import EmployeeBasic from "../../models/EmployeeBasic.js";
import { uploadDocumentToS3 } from "../../utils/s3Upload.js";
import mongoose from "mongoose";
import { resolveEmployeeId, getCompleteEmployee } from "../../services/employeeService.js";
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";

// @desc    Update a document in employee's documents list
// @route   PATCH /api/Employee/:id/document/:index
// @access  Private
export const updateDocument = async (req, res) => {
    try {
        const { id, index } = req.params;
        const {
            type,
            description,
            issueDate,
            expiryDate,
            cost,
            basicSalary,
            houseRentAllowance,
            vehicleAllowance,
            fuelAllowance,
            otherAllowance,
            totalSalary,
            document
        } = req.body;

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

        // Archive current version before replacing/editing
        const currentDoc = employee.documents[docIndex];
        if (currentDoc) {
            if (!employee.oldDocuments) employee.oldDocuments = [];
            employee.oldDocuments.push({
                type: currentDoc.type || '',
                description: currentDoc.description || '',
                issueDate: currentDoc.issueDate || null,
                expiryDate: currentDoc.expiryDate || null,
                cost: currentDoc.cost ?? null,
                basicSalary: currentDoc.basicSalary ?? null,
                houseRentAllowance: currentDoc.houseRentAllowance ?? null,
                vehicleAllowance: currentDoc.vehicleAllowance ?? null,
                fuelAllowance: currentDoc.fuelAllowance ?? null,
                otherAllowance: currentDoc.otherAllowance ?? null,
                totalSalary: currentDoc.totalSalary ?? null,
                createdAt: currentDoc.createdAt || null,
                archivedAt: new Date(),
                archiveReason: 'Replaced',
                document: currentDoc.document || null
            });
        }

        // Update fields on live document
        if (type) employee.documents[docIndex].type = type;
        if (description) employee.documents[docIndex].description = description;
        if (issueDate !== undefined) employee.documents[docIndex].issueDate = issueDate || null;
        if (expiryDate !== undefined) employee.documents[docIndex].expiryDate = expiryDate;
        if (cost !== undefined) {
            if (cost === '' || cost === null) {
                employee.documents[docIndex].cost = null;
            } else {
                const n = Number(String(cost).replace(/,/g, ''));
                employee.documents[docIndex].cost = Number.isFinite(n) ? n : null;
            }
        }
        if (basicSalary !== undefined) employee.documents[docIndex].basicSalary = (basicSalary === '' || basicSalary === null) ? null : Number(basicSalary);
        if (houseRentAllowance !== undefined) employee.documents[docIndex].houseRentAllowance = (houseRentAllowance === '' || houseRentAllowance === null) ? null : Number(houseRentAllowance);
        if (vehicleAllowance !== undefined) employee.documents[docIndex].vehicleAllowance = (vehicleAllowance === '' || vehicleAllowance === null) ? null : Number(vehicleAllowance);
        if (fuelAllowance !== undefined) employee.documents[docIndex].fuelAllowance = (fuelAllowance === '' || fuelAllowance === null) ? null : Number(fuelAllowance);
        if (otherAllowance !== undefined) employee.documents[docIndex].otherAllowance = (otherAllowance === '' || otherAllowance === null) ? null : Number(otherAllowance);
        if (totalSalary !== undefined) employee.documents[docIndex].totalSalary = (totalSalary === '' || totalSalary === null) ? null : Number(totalSalary);

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
        await triggerProfileReactivationIfNeeded({
            employeeId: employee.employeeId,
            actor: req.user,
            reason: "Document updated",
        });
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
