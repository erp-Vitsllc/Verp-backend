import EmployeeBasic from "../../models/EmployeeBasic.js";
import { uploadDocumentToS3 } from "../../utils/s3Upload.js";
import mongoose from "mongoose";
import { resolveEmployeeId, getCompleteEmployee } from "../../services/employeeService.js";
import { scheduleEmployeeProfileFileChangeHrEmailForRequest } from "../../utils/employeeInformativeHrNotify.js";
import { validateEmployeeDocumentPayload } from "../../utils/employeeDocumentValidation.js";
import { archiveEmployeeDocument } from "../../utils/archiveEmployeeDocument.js";
import { shouldArchiveEmployeeDocumentOnRenewal } from "../../utils/employeeDocumentRenewal.js";


// @desc    Update a document in employee's documents list
// @route   PATCH /api/Employee/:id/document/:index
// @access  Private
export const updateDocument = async (req, res) => {
    try {
        const { id, index } = req.params;
        const {
            type,
            documentName,
            description,
            issueDate,
            expiryDate,
            cost,
            isRenewMode,
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

        const currentDoc = employee.documents[docIndex];
        const isLabourModal = String(type ?? currentDoc?.type ?? "").trim() === "Labour Card Salary";
        const hasExistingFile = Boolean(currentDoc?.document?.url || currentDoc?.document?.name);
        const validation = validateEmployeeDocumentPayload(
            {
                type: type ?? currentDoc?.type,
                documentName: documentName ?? currentDoc?.documentName,
                description: description ?? currentDoc?.description,
                issueDate: issueDate ?? currentDoc?.issueDate,
                expiryDate: expiryDate ?? currentDoc?.expiryDate,
                cost: cost ?? currentDoc?.cost,
                document: document ?? currentDoc?.document,
            },
            {
                isLabourModal,
                requireFile: false,
                hasExistingFile,
            },
        );
        if (!validation.ok) {
            return res.status(400).json({ message: validation.message });
        }

        const proposedDoc = currentDoc?.toObject ? currentDoc.toObject() : JSON.parse(JSON.stringify(currentDoc || {}));
        if (type !== undefined) proposedDoc.type = type;
        if (documentName !== undefined) proposedDoc.documentName = documentName;
        if (description !== undefined) proposedDoc.description = description;
        if (issueDate !== undefined) proposedDoc.issueDate = issueDate || null;
        if (expiryDate !== undefined) proposedDoc.expiryDate = expiryDate;
        if (cost !== undefined) {
            if (cost === '' || cost === null) {
                proposedDoc.cost = null;
            } else {
                const n = Number(String(cost).replace(/,/g, ''));
                proposedDoc.cost = Number.isFinite(n) ? n : null;
            }
        }
        if (basicSalary !== undefined) proposedDoc.basicSalary = (basicSalary === '' || basicSalary === null) ? null : Number(basicSalary);
        if (houseRentAllowance !== undefined) proposedDoc.houseRentAllowance = (houseRentAllowance === '' || houseRentAllowance === null) ? null : Number(houseRentAllowance);
        if (vehicleAllowance !== undefined) proposedDoc.vehicleAllowance = (vehicleAllowance === '' || vehicleAllowance === null) ? null : Number(vehicleAllowance);
        if (fuelAllowance !== undefined) proposedDoc.fuelAllowance = (fuelAllowance === '' || fuelAllowance === null) ? null : Number(fuelAllowance);
        if (otherAllowance !== undefined) proposedDoc.otherAllowance = (otherAllowance === '' || otherAllowance === null) ? null : Number(otherAllowance);
        if (totalSalary !== undefined) proposedDoc.totalSalary = (totalSalary === '' || totalSalary === null) ? null : Number(totalSalary);

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
                proposedDoc.document = documentData;
            }
        }

        const hasExistingDocument = Boolean(
            currentDoc?.document?.url || currentDoc?.document?.data || currentDoc?.document?.name || currentDoc?.expiryDate,
        );
        const shouldArchivePrevious =
            isRenewMode === true &&
            Boolean(currentDoc?.expiryDate) &&
            shouldArchiveEmployeeDocumentOnRenewal({
                isRenewal: true,
                hasExistingDocument,
            });

        if (shouldArchivePrevious) {
            await archiveEmployeeDocument({
                employeeId: employee.employeeId,
                type: currentDoc.type || "Document",
                documentName: currentDoc.documentName || "",
                description: currentDoc.description || "",
                issueDate: currentDoc.issueDate || null,
                expiryDate: currentDoc.expiryDate || null,
                cost: currentDoc.cost ?? null,
                basicSalary: currentDoc.basicSalary ?? null,
                houseRentAllowance: currentDoc.houseRentAllowance ?? null,
                vehicleAllowance: currentDoc.vehicleAllowance ?? null,
                fuelAllowance: currentDoc.fuelAllowance ?? null,
                otherAllowance: currentDoc.otherAllowance ?? null,
                totalSalary: currentDoc.totalSalary ?? null,
                document: currentDoc.document || null,
            });
        }

        employee.documents[docIndex] = proposedDoc;
        await employee.save();
        
        const completeEmployee = await getCompleteEmployee(employee.employeeId);

        try {
            const { reconcileEmployeeDocumentExpiryDashboard } = await import(
                "../../utils/processDocumentExpiryReminders.js"
            );
            await reconcileEmployeeDocumentExpiryDashboard(employee._id || employee.employeeId);
        } catch (reconcileErr) {
            console.warn(
                "[updateDocument] reconcileEmployeeDocumentExpiryDashboard:",
                reconcileErr?.message || reconcileErr,
            );
        }

        scheduleEmployeeProfileFileChangeHrEmailForRequest({
            req,
            employeeId: employee.employeeId,
            sectionKey: "documents",
            sectionLabel: proposedDoc.documentName || proposedDoc.type || proposedDoc.description || "Document",
            action: isRenewMode === true ? "renewed" : "edited",
            attachments: proposedDoc.document,
            actor: req.user,
            isRenewal: isRenewMode === true,
        });

        res.status(200).json({
            message: "Document updated successfully",
            employee: completeEmployee
        });

    } catch (error) {
        console.error("Error updating document:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};
