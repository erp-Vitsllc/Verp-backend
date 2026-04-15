import EmployeeDrivingLicense from "../../models/EmployeeDrivingLicense.js";
import { resolveEmployeeId, getCompleteEmployee } from "../../services/employeeService.js";
import { uploadDocumentToS3, deleteDocumentFromS3 } from "../../utils/s3Upload.js";
import { archiveEmployeeDocument } from "../../utils/archiveEmployeeDocument.js";
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";

const REQUIRED_FIELDS = ["number", "issueDate", "expiryDate", "document"];

const buildMissingFields = (body, existingDocument) => {
    return REQUIRED_FIELDS.filter((field) => {
        if (field === "document") {
            // Check if document is provided OR if existing document exists in DB
            const hasDocument = body.document && typeof body.document === 'string' && body.document.trim() !== '';
            return !hasDocument && !existingDocument;
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

export const updateDrivingLicenseDetails = async (req, res) => {
    const { id } = req.params;
    const {
        number,
        issueDate,
        expiryDate,
        document,
        documentName,
        documentMime,
    } = req.body || {};

    // Type validation
    if (number !== undefined && typeof number !== 'string') {
        return res.status(400).json({ message: "License number must be a string" });
    }
    if (document !== undefined && typeof document !== 'string') {
        return res.status(400).json({ message: "Document must be a string (base64 or URL)" });
    }

    try {
        // Get employeeId first to check for existing documents
        const employee = await resolveEmployeeId(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found." });
        }

        const employeeId = employee.employeeId;

        // Check if existing document exists in database (check for both url and data for backward compatibility)
        const existingDrivingLicense = await EmployeeDrivingLicense.findOne({ employeeId });
        const existingDocument = existingDrivingLicense?.drivingLicenceDetails?.document?.url || existingDrivingLicense?.drivingLicenceDetails?.document?.data;

        const missingFields = buildMissingFields({ number, issueDate, expiryDate, document }, existingDocument);
        if (missingFields.length > 0) {
            return res.status(400).json({
                message: "Missing required Driving License fields.",
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

        const previousDrivingLicense = existingDrivingLicense?.drivingLicenceDetails;
        const hasExistingDocument = Boolean(previousDrivingLicense?.document?.url || previousDrivingLicense?.document?.data);
        const hasNewDocumentUpload = Boolean(document && typeof document === "string" && document.trim() !== "");
        const shouldArchivePrevious = hasExistingDocument && hasNewDocumentUpload;
        if (shouldArchivePrevious) {
            await archiveEmployeeDocument({
                employeeId,
                type: "Driving License",
                description: previousDrivingLicense?.number ? `License No: ${previousDrivingLicense.number}` : "",
                issueDate: previousDrivingLicense?.issueDate || null,
                expiryDate: previousDrivingLicense?.expiryDate || null,
                document: previousDrivingLicense.document,
            });
        }

        // Handle document upload to IDrive (S3) if new document provided
        let documentData = undefined;
        if (document && document.trim() !== '') {
            // Check if it's already a URL (IDrive or otherwise)
            if (document.startsWith('http://') || document.startsWith('https://')) {
                // Already a URL
                documentData = {
                    url: document,
                    name: documentName || "",
                    mimeType: documentMime || "",
                };
            } else {
                // Upload base64 to IDrive
                const uploadResult = await uploadDocumentToS3(
                    document,
                    `employee-documents/${employeeId}/driving-license`,
                    documentName || 'driving-license.pdf',
                    'raw'
                );

                // Delete old file only when it is not archived in oldDocuments.
                if (!shouldArchivePrevious && existingDrivingLicense?.drivingLicenceDetails?.document?.publicId) {
                    await deleteDocumentFromS3(existingDrivingLicense.drivingLicenceDetails.document.publicId);
                }

                documentData = {
                    url: uploadResult.url,
                    publicId: uploadResult.publicId,
                    name: documentName || "",
                    mimeType: documentMime || "",
                };
            }
        } else {
            // Preserve existing document if no new one provided
            documentData = existingDrivingLicense?.drivingLicenceDetails?.document || undefined;
        }

        // Build payload - preserve existing document if no new one provided
        const drivingLicensePayload = {
            number: number.trim(),
            issueDate: parsedIssueDate,
            expiryDate: parsedExpiryDate,
            document: documentData,
            lastUpdated: new Date(),
        };

        // Update or create Driving License record
        const updatedDrivingLicense = await EmployeeDrivingLicense.findOneAndUpdate(
            { employeeId },
            {
                $set: {
                    drivingLicenceDetails: drivingLicensePayload,
                },
            },
            { upsert: true, new: true }
        );

        console.log("✅ Driving License details saved for employee:", employeeId);
        console.log("   Driving License Number:", drivingLicensePayload.number);
        console.log("   Expiry Date:", drivingLicensePayload.expiryDate);

        await triggerProfileReactivationIfNeeded({
            employeeId,
            actor: req.user,
            reason: "Driving license details updated",
        });
        const completeEmployee = await getCompleteEmployee(employeeId);

        return res.json({
            message: "Driving License details updated successfully.",
            drivingLicenceDetails: updatedDrivingLicense.drivingLicenceDetails,
            employee: completeEmployee
        });
    } catch (error) {
        console.error("Failed to update Driving License details:", error);
        return res.status(500).json({
            message: "Failed to update Driving License details.",
            error: error.message,
        });
    }
};











