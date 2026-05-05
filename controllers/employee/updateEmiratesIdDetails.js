import EmployeeEmiratesId from "../../models/EmployeeEmiratesId.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { resolveEmployeeId, getCompleteEmployee } from "../../services/employeeService.js";
import { uploadDocumentToS3, deleteDocumentFromS3 } from "../../utils/s3Upload.js";
import { archiveEmployeeDocument } from "../../utils/archiveEmployeeDocument.js";
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";
import { skipLiveProfileWritesPendingHr, queueOrTriggerProfileChange } from "../../utils/pushPendingReactivationChange.js";
import { markProfileActivationHoldResolvedForSection } from "../../utils/markProfileActivationHoldResolved.js";

const REQUIRED_FIELDS = ["number", "issueDate", "expiryDate", "upload"];

const buildMissingFields = (body, existingDocument) => {
    return REQUIRED_FIELDS.filter((field) => {
        if (field === "upload") {
            // Check if upload is provided OR if existing document exists in DB
            const hasUploadString = body.upload && typeof body.upload === "string" && body.upload.trim() !== "";
            const hasUploadObject = body.upload && typeof body.upload === "object" && (
                (typeof body.upload.url === "string" && body.upload.url.trim() !== "") ||
                (typeof body.upload.data === "string" && body.upload.data.trim() !== "")
            );
            const hasUpload = hasUploadString || hasUploadObject;
            return !hasUpload && !existingDocument;
        }
        const value = body[field];
        return value === undefined || value === null || value === "";
    });
};

const normalizeUploadInput = (upload) => {
    if (typeof upload === "string") return upload.trim();
    if (upload && typeof upload === "object") {
        if (typeof upload.url === "string" && upload.url.trim() !== "") return upload.url.trim();
        if (typeof upload.data === "string" && upload.data.trim() !== "") return upload.data.trim();
    }
    return "";
};

const normalizeDate = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

export const updateEmiratesIdDetails = async (req, res) => {
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
    const normalizedUpload = normalizeUploadInput(upload);
    if (upload !== undefined && typeof upload !== "string" && typeof upload !== "object") {
        return res.status(400).json({ message: "Upload must be a string or an object containing url/data" });
    }

    try {
        // Get employeeId first to check for existing documents
        const employee = await resolveEmployeeId(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found." });
        }

        const employeeId = employee.employeeId;
        const employeeBasic = await EmployeeBasic.findOne({ employeeId })
            .select("company profileStatus profileWorkflow profileApprovalStatus")
            .lean();
        const skipLive = skipLiveProfileWritesPendingHr(employeeBasic);

        // Check if existing document exists in database (check for both url and data for backward compatibility)
        const existingEmiratesId = await EmployeeEmiratesId.findOne({ employeeId });
        const existingDocument = existingEmiratesId?.emiratesId?.document?.url || existingEmiratesId?.emiratesId?.document?.data;

        const missingFields = buildMissingFields({ number, issueDate, expiryDate, upload: normalizedUpload || upload }, existingDocument);
        if (missingFields.length > 0) {
            return res.status(400).json({
                message: "Missing required Emirates ID fields.",
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

        const previousEmiratesId = existingEmiratesId?.emiratesId;
        const hasExistingDocument = Boolean(previousEmiratesId?.document?.url || previousEmiratesId?.document?.data);
        const hasNewDocumentUpload = Boolean(normalizedUpload);
        const shouldArchivePrevious = !skipLive && hasExistingDocument && hasNewDocumentUpload;
        if (shouldArchivePrevious) {
            await archiveEmployeeDocument({
                employeeId,
                type: "Emirates ID",
                description: previousEmiratesId?.number ? `Emirates ID No: ${previousEmiratesId.number}` : "",
                issueDate: previousEmiratesId?.issueDate || null,
                expiryDate: previousEmiratesId?.expiryDate || null,
                document: previousEmiratesId.document,
            });
        }

        // Handle document upload to IDrive (S3) if new document provided
        let documentData = undefined;
        if (normalizedUpload) {
            // Check if it's already a URL (IDrive or otherwise)
            if (normalizedUpload.startsWith('http://') || normalizedUpload.startsWith('https://')) {
                // Already a URL
                documentData = {
                    url: normalizedUpload,
                    name: uploadName || "",
                    mimeType: uploadMime || "",
                };
            } else {
                // Upload base64 to IDrive
                const uploadResult = await uploadDocumentToS3(
                    normalizedUpload,
                    `employee-documents/${employeeId}/emirates-id`,
                    uploadName || 'emirates-id.pdf',
                    'raw'
                );

                // Delete old file only when it is not archived in oldDocuments.
                if (!shouldArchivePrevious && existingEmiratesId?.emiratesId?.document?.publicId) {
                    await deleteDocumentFromS3(existingEmiratesId.emiratesId.document.publicId);
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
            documentData = existingEmiratesId?.emiratesId?.document || undefined;
        }

        // Build payload - preserve existing document if no new one provided
        const emiratesIdPayload = {
            number: typeof number === 'string' ? number.trim() : number,
            issueDate: parsedIssueDate,
            expiryDate: parsedExpiryDate,
            document: documentData,
            lastUpdated: new Date(),
        };

        let updatedEmiratesId = existingEmiratesId;
        if (!skipLive) {
            updatedEmiratesId = await EmployeeEmiratesId.findOneAndUpdate(
                { employeeId },
                {
                    $set: {
                        emiratesId: emiratesIdPayload,
                    },
                },
                { upsert: true, new: true }
            );
        }

        const emiratesChangeEntry = {
            card: "Emirates ID",
            reason: "Emirates ID details updated",
            section: "emiratesId",
            changeType: "update",
            targetIndex: null,
            previousData: previousEmiratesId || null,
            proposedData: emiratesIdPayload,
        };

        if (skipLive) {
            await queueOrTriggerProfileChange({
                employeeId,
                actor: req.user,
                reason: "Emirates ID details updated",
                employeeBasic,
                changeEntry: emiratesChangeEntry,
            });
        } else {
            await triggerProfileReactivationIfNeeded({
                employeeId,
                actor: req.user,
                reason: "Emirates ID details updated",
                changeEntry: null,
                trackDefaultChange: true,
            });
        }
        try {
            await markProfileActivationHoldResolvedForSection(employeeId, "emiratesId");
        } catch (_e) {
            /* non-fatal */
        }
        const completeEmployee = await getCompleteEmployee(employeeId);

        return res.json({
            message: skipLive
                ? "Emirates ID change queued for HR activation approval."
                : "Emirates ID details updated successfully.",
            emiratesIdDetails: updatedEmiratesId?.emiratesId || completeEmployee?.emiratesIdDetails,
            employee: completeEmployee
        });
    } catch (error) {
        console.error("Failed to update Emirates ID details:", error);
        return res.status(500).json({
            message: "Failed to update Emirates ID details.",
            error: error.message,
        });
    }
};













