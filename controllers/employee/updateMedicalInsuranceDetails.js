import EmployeeMedicalInsurance from "../../models/EmployeeMedicalInsurance.js";
import { resolveEmployeeId, getCompleteEmployee } from "../../services/employeeService.js";
import { uploadDocumentToS3, deleteDocumentFromS3 } from "../../utils/s3Upload.js";
import { archiveEmployeeDocument } from "../../utils/archiveEmployeeDocument.js";
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";

const REQUIRED_FIELDS = ["provider", "number", "issueDate", "expiryDate", "upload"];

const buildMissingFields = (body, existingDocument) => {
    return REQUIRED_FIELDS.filter((field) => {
        if (field === "upload") {
            // Check if upload is provided OR if existing document exists in DB
            const hasUpload = body.upload && typeof body.upload === 'string' && body.upload.trim() !== '';
            return !hasUpload && !existingDocument;
        }
        const value = body[field];
        return value === undefined || value === null || value === "";
    });
};

const normalizeDate = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

export const updateMedicalInsuranceDetails = async (req, res) => {
    const { id } = req.params;
    const {
        provider,
        number,
        issueDate,
        expiryDate,
        upload,
        uploadName,
        uploadMime,
    } = req.body || {};

    // Type validation
    if (provider !== undefined && typeof provider !== 'string') {
        return res.status(400).json({ message: "Provider must be a string" });
    }
    if (upload !== undefined && typeof upload !== 'string') {
        return res.status(400).json({ message: "Upload must be a string (base64 or URL)" });
    }

    try {
        // Get employeeId first to check for existing documents
        const employee = await resolveEmployeeId(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found." });
        }

        const employeeId = employee.employeeId;

        // Check if existing document exists in database (check for both url and data for backward compatibility)
        const existingMedicalInsurance = await EmployeeMedicalInsurance.findOne({ employeeId });
        const existingDocument = existingMedicalInsurance?.medicalInsurance?.document?.url || existingMedicalInsurance?.medicalInsurance?.document?.data;

        const missingFields = buildMissingFields({ provider, number, issueDate, expiryDate, upload }, existingDocument);
        if (missingFields.length > 0) {
            return res.status(400).json({
                message: "Missing required Medical Insurance fields.",
                missingFields,
            });
        }

        const parsedIssueDate = normalizeDate(issueDate);
        const parsedExpiryDate = normalizeDate(expiryDate);
        if (!parsedIssueDate || !parsedExpiryDate) {
            return res.status(400).json({
                message: "Invalid issue or expiry date provided.",
            });
        }

        const previousMedicalInsurance = existingMedicalInsurance?.medicalInsurance;
        const hasExistingDocument = Boolean(previousMedicalInsurance?.document?.url || previousMedicalInsurance?.document?.data);
        const hasNewDocumentUpload = Boolean(upload && typeof upload === "string" && upload.trim() !== "");
        const shouldArchivePrevious = hasExistingDocument && hasNewDocumentUpload;
        if (shouldArchivePrevious) {
            await archiveEmployeeDocument({
                employeeId,
                type: "Medical Insurance",
                description: previousMedicalInsurance?.number
                    ? `Policy No: ${previousMedicalInsurance.number}`
                    : (previousMedicalInsurance?.provider || ""),
                issueDate: previousMedicalInsurance?.issueDate || null,
                expiryDate: previousMedicalInsurance?.expiryDate || null,
                document: previousMedicalInsurance.document,
            });
        }

        // Handle document upload to IDrive (S3) if new document provided
        let documentData = undefined;
        if (upload && typeof upload === 'string' && upload.trim() !== '') {
            // Check if it's already a URL (IDrive or otherwise)
            if (upload.startsWith('http://') || upload.startsWith('https://')) {
                // Already a URL
                documentData = {
                    url: upload,
                    name: uploadName || "",
                    mimeType: uploadMime || "",
                };
            } else {
                // Upload base64 to IDrive
                const uploadResult = await uploadDocumentToS3(
                    upload,
                    `employee-documents/${employeeId}/medical-insurance`,
                    uploadName || 'medical-insurance.pdf',
                    'raw'
                );

                // Delete old file only when it is not archived in oldDocuments.
                if (!shouldArchivePrevious && existingMedicalInsurance?.medicalInsurance?.document?.publicId) {
                    await deleteDocumentFromS3(existingMedicalInsurance.medicalInsurance.document.publicId);
                }

                documentData = {
                    url: uploadResult.url,
                    publicId: uploadResult.publicId,
                    name: uploadName || "",
                    mimeType: uploadMime || "",
                };
            }
        } else {
            // Preserve existing document if no new one provided
            documentData = existingMedicalInsurance?.medicalInsurance?.document || undefined;
        }

        // Build payload - preserve existing document if no new one provided
        const medicalInsurancePayload = {
            provider: typeof provider === 'string' ? provider.trim() : provider,
            number: number,
            issueDate: parsedIssueDate,
            expiryDate: parsedExpiryDate,
            document: documentData,
            lastUpdated: new Date(),
        };

        // Update or create Medical Insurance record
        const updatedMedicalInsurance = await EmployeeMedicalInsurance.findOneAndUpdate(
            { employeeId },
            {
                $set: {
                    medicalInsurance: medicalInsurancePayload,
                },
            },
            { upsert: true, new: true }
        );

        await triggerProfileReactivationIfNeeded({
            employeeId,
            actor: req.user,
            reason: "Medical insurance details updated",
        });
        const completeEmployee = await getCompleteEmployee(employeeId);

        return res.json({
            message: "Medical Insurance details updated successfully.",
            medicalInsuranceDetails: updatedMedicalInsurance.medicalInsurance,
            employee: completeEmployee
        });
    } catch (error) {
        console.error("Failed to update Medical Insurance details:", error);
        return res.status(500).json({
            message: "Failed to update Medical Insurance details.",
            error: error.message,
        });
    }
};












