import EmployeeLabourCard from "../../models/EmployeeLabourCard.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { resolveEmployeeId, getCompleteEmployee } from "../../services/employeeService.js";
import { uploadDocumentToS3, deleteDocumentFromS3 } from "../../utils/s3Upload.js";
import { archiveEmployeeDocument } from "../../utils/archiveEmployeeDocument.js";
import {
    archiveAndClearLiveEmployeeRenewal,
    shouldArchiveEmployeeDocumentOnRenewal,
} from "../../utils/employeeDocumentRenewal.js";
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";
import { skipLiveProfileWritesPendingHr, queueOrTriggerProfileChange } from "../../utils/pushPendingReactivationChange.js";
import { markProfileActivationHoldResolvedForSection } from "../../utils/markProfileActivationHoldResolved.js";
import { validateEmployeeLabourCardNoticePeriod } from "../../utils/employeeLabourCardValidation.js";

const REQUIRED_FIELDS = ["number", "issueDate", "expiryDate", "noticePeriodMonths", "upload"];

const buildMissingFields = (body, existingDocument, existingContractDocument) => {
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
        if (field === "contractUpload") {
            const hasContractUploadString = body.contractUpload && typeof body.contractUpload === "string" && body.contractUpload.trim() !== "";
            const hasContractUploadObject = body.contractUpload && typeof body.contractUpload === "object" && (
                (typeof body.contractUpload.url === "string" && body.contractUpload.url.trim() !== "") ||
                (typeof body.contractUpload.data === "string" && body.contractUpload.data.trim() !== "")
            );
            const hasContractUpload = hasContractUploadString || hasContractUploadObject;
            return !hasContractUpload && !existingContractDocument;
        }
        const value = body[field];
        return value === undefined || value === null || value === "";
    });
};

const normalizeUploadInput = (value) => {
    if (typeof value === "string") return value.trim();
    if (value && typeof value === "object") {
        if (typeof value.url === "string" && value.url.trim() !== "") return value.url.trim();
        if (typeof value.data === "string" && value.data.trim() !== "") return value.data.trim();
    }
    return "";
};

const normalizeDate = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

const isExistingStoredUpload = (value) => {
    if (!value || typeof value !== "string") return false;
    const trimmed = value.trim();
    return trimmed.startsWith("http://") || trimmed.startsWith("https://");
};

const assertPdfUpload = (name, mime, label) => {
    const fileName = String(name || "").toLowerCase();
    const fileMime = String(mime || "").toLowerCase();
    if (fileMime && fileMime !== "application/pdf" && !fileName.endsWith(".pdf")) {
        return `${label}: Only PDF files are allowed`;
    }
    if (!fileMime && fileName && !fileName.endsWith(".pdf")) {
        return `${label}: Only PDF files are allowed`;
    }
    return null;
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
        contractUpload,
        contractUploadName,
        contractUploadMime,
        noticePeriodMonths,
    } = req.body || {};

    // Type validation
    if (number !== undefined && typeof number !== 'string') {
        return res.status(400).json({ message: "Number must be a string" });
    }
    const normalizedUpload = normalizeUploadInput(upload);
    const normalizedContractUpload = normalizeUploadInput(contractUpload);
    if (upload !== undefined && typeof upload !== "string" && typeof upload !== "object") {
        return res.status(400).json({ message: "Upload must be a string or an object containing url/data" });
    }
    if (contractUpload !== undefined && typeof contractUpload !== "string" && typeof contractUpload !== "object") {
        return res.status(400).json({ message: "Contract upload must be a string or an object containing url/data" });
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
        const skipLive = skipLiveProfileWritesPendingHr(employeeBasic, req.user);

        // Check if existing document exists in database (check for both url and data for backward compatibility)
        const existingLabourCard = await EmployeeLabourCard.findOne({ employeeId });
        const existingDocument = existingLabourCard?.labourCard?.document?.url || existingLabourCard?.labourCard?.document?.data;
        const existingContractDocument = existingLabourCard?.labourCard?.labourContractAttachment?.url || existingLabourCard?.labourCard?.labourContractAttachment?.data;

        const effectiveNoticePeriod =
            noticePeriodMonths !== undefined && noticePeriodMonths !== null && noticePeriodMonths !== ""
                ? noticePeriodMonths
                : existingLabourCard?.labourCard?.noticePeriodMonths;

        if (normalizedUpload && !isExistingStoredUpload(normalizedUpload)) {
            const pdfError = assertPdfUpload(uploadName, uploadMime, "Labour Card document");
            if (pdfError) return res.status(400).json({ message: pdfError });
        }
        if (normalizedContractUpload && !isExistingStoredUpload(normalizedContractUpload)) {
            const pdfError = assertPdfUpload(contractUploadName, contractUploadMime, "Labour contract attachment");
            if (pdfError) return res.status(400).json({ message: pdfError });
        }

        const missingFields = buildMissingFields(
            {
                number,
                issueDate,
                expiryDate,
                noticePeriodMonths: effectiveNoticePeriod,
                upload: normalizedUpload || upload,
                contractUpload: normalizedContractUpload || contractUpload,
            },
            existingDocument,
            existingContractDocument
        );
        if (missingFields.length > 0) {
            return res.status(400).json({
                message: "Missing required Labour Card fields.",
                missingFields,
            });
        }

        const noticePeriodErr = validateEmployeeLabourCardNoticePeriod(effectiveNoticePeriod);
        if (noticePeriodErr) {
            return res.status(400).json({ message: noticePeriodErr });
        }

        const parsedIssueDate = normalizeDate(issueDate);
        const parsedExpiryDate = normalizeDate(expiryDate);

        if (!parsedIssueDate) {
            return res.status(400).json({
                message: "Invalid issue date provided.",
            });
        }

        if (!parsedExpiryDate) {
            return res.status(400).json({
                message: "Invalid expiry date provided.",
            });
        }

        if (parsedExpiryDate <= parsedIssueDate) {
            return res.status(400).json({
                message: "Expiry date must be later than the issue date.",
            });
        }

        const previousLabourCard = existingLabourCard?.labourCard;
        const isRenewal = req.body?.isRenewal === true;
        const hasExistingDocument = Boolean(previousLabourCard?.document?.url || previousLabourCard?.document?.data);
        const hasExistingContractDocument = Boolean(previousLabourCard?.labourContractAttachment?.url || previousLabourCard?.labourContractAttachment?.data);
        const hasNewDocumentUpload = Boolean(normalizedUpload);
        const hasNewContractDocumentUpload = Boolean(normalizedContractUpload);
        const shouldArchivePrevious = await archiveAndClearLiveEmployeeRenewal({
            employeeId,
            skipLive,
            isRenewal,
            hasExistingDocument,
            hasNewDocumentUpload,
            section: "labourCard",
            archiveParams: {
                type: "Labour Card",
                description: previousLabourCard?.number ? `Labour Card No: ${previousLabourCard.number}` : "",
                issueDate: previousLabourCard?.issueDate || null,
                expiryDate: previousLabourCard?.expiryDate || null,
                document: previousLabourCard?.document,
            },
        });
        const shouldArchivePreviousContract = shouldArchiveEmployeeDocumentOnRenewal({
            isRenewal,
            hasExistingDocument: hasExistingContractDocument,
            hasNewDocumentUpload: hasNewContractDocumentUpload,
        });
        if (shouldArchivePreviousContract) {
            await archiveEmployeeDocument({
                employeeId,
                type: "Labour Contract",
                description: previousLabourCard?.number ? `Labour Contract (Labour Card No: ${previousLabourCard.number})` : "Labour Contract",
                issueDate: previousLabourCard?.issueDate || null,
                expiryDate: previousLabourCard?.expiryDate || null,
                document: previousLabourCard.labourContractAttachment,
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
                    `employee-documents/${employeeId}/labour-card`,
                    uploadName || 'labour-card.pdf',
                    'raw'
                );

                // Delete old file only when it is not archived in oldDocuments.
                if (!shouldArchivePrevious && existingLabourCard?.labourCard?.document?.publicId) {
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

        let contractDocumentData = undefined;
        if (normalizedContractUpload) {
            if (normalizedContractUpload.startsWith('http://') || normalizedContractUpload.startsWith('https://')) {
                contractDocumentData = {
                    url: normalizedContractUpload,
                    name: contractUploadName || "",
                    mimeType: contractUploadMime || "",
                };
            } else {
                const contractUploadResult = await uploadDocumentToS3(
                    normalizedContractUpload,
                    `employee-documents/${employeeId}/labour-contract`,
                    contractUploadName || 'labour-contract.pdf',
                    'raw'
                );

                if (!shouldArchivePreviousContract && existingLabourCard?.labourCard?.labourContractAttachment?.publicId) {
                    await deleteDocumentFromS3(existingLabourCard.labourCard.labourContractAttachment.publicId);
                }

                contractDocumentData = {
                    url: contractUploadResult.url,
                    publicId: contractUploadResult.publicId,
                    name: contractUploadName || "",
                    mimeType: contractUploadMime || "",
                };
            }
        } else {
            contractDocumentData = existingLabourCard?.labourCard?.labourContractAttachment || undefined;
        }

        // Build payload - preserve existing document if no new one provided
        const labourCardPayload = {
            number: number,
            issueDate: parsedIssueDate,
            expiryDate: parsedExpiryDate,
            noticePeriodMonths: parseInt(String(effectiveNoticePeriod), 10),
            document: documentData,
            labourContractAttachment: contractDocumentData,
            lastUpdated: new Date(),
        };

        let updatedLabourCard = existingLabourCard;
        if (!skipLive) {
            updatedLabourCard = await EmployeeLabourCard.findOneAndUpdate(
                { employeeId },
                {
                    $set: {
                        labourCard: labourCardPayload,
                    },
                },
                { upsert: true, new: true }
            );
            if (parsedIssueDate) {
                await EmployeeBasic.updateOne(
                    { employeeId },
                    { $set: { contractJoiningDate: parsedIssueDate } },
                );
            }
        }

        const labourChangeEntry = {
            card: "Labour Card",
            reason: "Labour card details updated",
            section: "labourCard",
            changeType: "update",
            targetIndex: null,
            isRenewal,
            previousData: previousLabourCard || null,
            proposedData: labourCardPayload,
        };

        if (skipLive) {
            await queueOrTriggerProfileChange({
                employeeId,
                actor: req.user,
                reason: "Labour card details updated",
                employeeBasic,
                changeEntry: labourChangeEntry,
            });
        } else {
            await triggerProfileReactivationIfNeeded({
                employeeId,
                actor: req.user,
                reason: "Labour card details updated",
                changeEntry: null,
                trackDefaultChange: true,
            });
        }
        try {
            await markProfileActivationHoldResolvedForSection(employeeId, "labourCard");
        } catch (_e) {
            /* non-fatal */
        }
        const completeEmployee = await getCompleteEmployee(employeeId);

        return res.json({
            message: skipLive
                ? "Labour Card change queued for HR activation approval."
                : "Labour Card details updated successfully.",
            labourCardDetails: updatedLabourCard?.labourCard || completeEmployee?.labourCardDetails,
            employee: completeEmployee
        });
    } catch (error) {
        console.error("Failed to update Labour Card details:", error);
        return res.status(500).json({
            message: "Failed to update Labour Card details.",
            error: error.message,
        });
    }
};












