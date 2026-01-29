import EmployeeLabourCard from "../../models/EmployeeLabourCard.js";
import { resolveEmployeeId } from "../../services/employeeService.js";
import { uploadDocumentToS3, deleteDocumentFromS3 } from "../../utils/s3Upload.js";

const REQUIRED_FIELDS = ["number", "expiryDate", "upload"];

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

export const updateLabourCardDetails = async (req, res) => {
    const { id } = req.params;
    const {
        number,
        issueDate,
        expiryDate,
        upload,
        uploadName,
        uploadMime,
    } = req.body || {};

    // Type validation
    if (number !== undefined && typeof number !== 'string') {
        return res.status(400).json({ message: "Number must be a string" });
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
        const existingLabourCard = await EmployeeLabourCard.findOne({ employeeId });
        const existingDocument = existingLabourCard?.labourCard?.document?.url || existingLabourCard?.labourCard?.document?.data;

        const missingFields = buildMissingFields({ number, expiryDate, upload }, existingDocument);
        if (missingFields.length > 0) {
            return res.status(400).json({
                message: "Missing required Labour Card fields.",
                missingFields,
            });
        }

        const parsedIssueDate = normalizeDate(issueDate);
        const parsedExpiryDate = normalizeDate(expiryDate);

        // Only validate expiryDate is valid. issueDate is optional.
        if (!parsedExpiryDate) {
            return res.status(400).json({
                message: "Invalid expiry date provided.",
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
                    `employee-documents/${employeeId}/labour-card`,
                    uploadName || 'labour-card.pdf',
                    'raw'
                );

                // Delete old document from IDrive if exists
                if (existingLabourCard?.labourCard?.document?.publicId) {
                    await deleteDocumentFromS3(existingLabourCard.labourCard.document.publicId);
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
            documentData = existingLabourCard?.labourCard?.document || undefined;
        }

        // Build payload - preserve existing document if no new one provided
        const labourCardPayload = {
            number: number,
            issueDate: parsedIssueDate,
            expiryDate: parsedExpiryDate,
            document: documentData,
            lastUpdated: new Date(),
        };

        // Update or create Labour Card record
        const updatedLabourCard = await EmployeeLabourCard.findOneAndUpdate(
            { employeeId },
            {
                $set: {
                    labourCard: labourCardPayload,
                },
            },
            { upsert: true, new: true }
        );

        return res.json({
            message: "Labour Card details updated successfully.",
            labourCardDetails: updatedLabourCard.labourCard,
        });
    } catch (error) {
        console.error("Failed to update Labour Card details:", error);
        return res.status(500).json({
            message: "Failed to update Labour Card details.",
            error: error.message,
        });
    }
};












