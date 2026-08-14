import EmployeeBasic from "../../models/EmployeeBasic.js";
import { uploadDocumentToS3 } from "../../utils/s3Upload.js";
import mongoose from "mongoose";
import { resolveEmployeeId, getCompleteEmployee } from "../../services/employeeService.js";
import { scheduleEmployeeProfileFileChangeHrEmailForRequest } from "../../utils/employeeInformativeHrNotify.js";
import { validateEmployeeDocumentPayload } from "../../utils/employeeDocumentValidation.js";


// @desc    Add a document to employee's documents list
// @route   POST /api/Employee/:id/document
// @access  Private
export const addDocument = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            type,
            documentName,
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

        const isLabourModal = String(type || "").trim() === "Labour Card Salary";
        const validation = validateEmployeeDocumentPayload(req.body, {
            isLabourModal,
            requireFile: true,
            hasExistingFile: false,
        });
        if (!validation.ok) {
            return res.status(400).json({ message: validation.message });
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
                    url: uploadResult.publicId || uploadResult.url,
                    mimeType: document.mimeType || 'application/pdf',
                    publicId: uploadResult.publicId // S3 Key
                };
            } else if (document.url) {
                // Already uploaded or just a link
                documentData = {
                    name: document.name,
                    url: document.url,
                    mimeType: document.mimeType,
                    publicId: document.publicId || (document.url && !String(document.url).startsWith('http') ? document.url : undefined)
                };
            }
        }

        const parseCost = (c) => {
            if (c === undefined || c === null || c === '') return null;
            const n = Number(String(c).replace(/,/g, ''));
            return Number.isFinite(n) ? n : null;
        };

        const newDocument = {
            type,
            documentName: documentName || '',
            description,
            issueDate: issueDate || null,
            expiryDate,
            cost: parseCost(cost),
            basicSalary: basicSalary !== undefined && basicSalary !== null && basicSalary !== '' ? Number(basicSalary) : null,
            houseRentAllowance: houseRentAllowance !== undefined && houseRentAllowance !== null && houseRentAllowance !== '' ? Number(houseRentAllowance) : null,
            vehicleAllowance: vehicleAllowance !== undefined && vehicleAllowance !== null && vehicleAllowance !== '' ? Number(vehicleAllowance) : null,
            fuelAllowance: fuelAllowance !== undefined && fuelAllowance !== null && fuelAllowance !== '' ? Number(fuelAllowance) : null,
            otherAllowance: otherAllowance !== undefined && otherAllowance !== null && otherAllowance !== '' ? Number(otherAllowance) : null,
            totalSalary: totalSalary !== undefined && totalSalary !== null && totalSalary !== '' ? Number(totalSalary) : null,
            document: documentData,
            createdAt: new Date()
        };

            if (!employee.documents) employee.documents = [];
            employee.documents.push(newDocument);
            await employee.save();
        
        const completeEmployee = await getCompleteEmployee(employee.employeeId);

        scheduleEmployeeProfileFileChangeHrEmailForRequest({
            req,
            employeeId: employee.employeeId,
            sectionKey: "documents",
            sectionLabel: documentName || type || description || "Document",
            action: "added",
            attachments: documentData,
            actor: req.user,
        });

        res.status(200).json({
            message: "Document added successfully",
            employee: completeEmployee
        });

    } catch (error) {
        console.error("Error adding document:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};
