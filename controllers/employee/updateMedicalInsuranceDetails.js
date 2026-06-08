import EmployeeMedicalInsurance from "../../models/EmployeeMedicalInsurance.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { resolveEmployeeId, getCompleteEmployee } from "../../services/employeeService.js";
import { uploadDocumentToS3, deleteDocumentFromS3 } from "../../utils/s3Upload.js";
import { archiveEmployeeDocument } from "../../utils/archiveEmployeeDocument.js";
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";
import { shouldSkipLiveEmployeeSection, queueOrTriggerProfileChange } from "../../utils/pushPendingReactivationChange.js";
import { markProfileActivationHoldResolvedForSection } from "../../utils/markProfileActivationHoldResolved.js";
import { scheduleEmployeeProfileFileChangeHrEmailForRequest } from "../../utils/employeeInformativeHrNotify.js";

const REQUIRED_FIELDS = ["provider", "number", "issueDate", "expiryDate", "upload"];

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
        const skipLive = shouldSkipLiveEmployeeSection(employeeBasic, "medicalInsurance");

        // Check if existing document exists in database (check for both url and data for backward compatibility)
        const existingMedicalInsurance = await EmployeeMedicalInsurance.findOne({ employeeId });
        const existingDocument = existingMedicalInsurance?.medicalInsurance?.document?.url || existingMedicalInsurance?.medicalInsurance?.document?.data;

        const missingFields = buildMissingFields({ provider, number, issueDate, expiryDate, upload: normalizedUpload || upload }, existingDocument);
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
        const hasNewDocumentUpload = Boolean(normalizedUpload);
        const shouldArchivePrevious = !skipLive && hasExistingDocument && hasNewDocumentUpload;
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
        let updatedMedicalInsurance = existingMedicalInsurance;
        if (!skipLive) {
            updatedMedicalInsurance = await EmployeeMedicalInsurance.findOneAndUpdate(
                { employeeId },
                {
                    $set: {
                        medicalInsurance: medicalInsurancePayload,
                    },
                },
                { upsert: true, new: true }
            );
        }

        const medicalChangeEntry = {
            card: "Medical Insurance",
            reason: "Medical Insurance details updated",
            section: "medicalInsurance",
            changeType: "update",
            targetIndex: null,
            previousData: previousMedicalInsurance || null,
            proposedData: medicalInsurancePayload,
        };

        if (skipLive) {
            await queueOrTriggerProfileChange({
                employeeId,
                actor: req.user,
                reason: "Medical Insurance details updated",
                employeeBasic,
                changeEntry: medicalChangeEntry,
            });
        } else {
            await triggerProfileReactivationIfNeeded({
                employeeId,
                actor: req.user,
                reason: "Medical Insurance details updated",
                changeEntry: null,
                trackDefaultChange: true,
            });
        }
        try {
            await markProfileActivationHoldResolvedForSection(employeeId, "medicalInsurance");
        } catch (_e) {
            /* non-fatal */
        }
        
        const completeEmployee = await getCompleteEmployee(employeeId);

        scheduleEmployeeProfileFileChangeHrEmailForRequest({
            employeeId,
            employeeBasic,
            sectionKey: "medicalInsurance",
            sectionLabel: "Medical Insurance",
            action: hasNewDocumentUpload && hasExistingDocument ? "renewed" : "edited",
            attachments: updatedMedicalInsurance?.medicalInsurance?.document || medicalInsurancePayload?.document,
            actor: req.user,
            skipLive,
        });

        return res.json({
            message: skipLive
                ? "Medical Insurance change queued for HR activation approval."
                : "Medical Insurance details updated successfully.",
            medicalInsuranceDetails: updatedMedicalInsurance?.medicalInsurance || completeEmployee?.medicalInsuranceDetails,
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












