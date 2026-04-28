import EmployeePassport from "../../models/EmployeePassport.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { resolveEmployeeId, getCompleteEmployee } from "../../services/employeeService.js";
import { uploadDocumentToS3, deleteDocumentFromS3 } from "../../utils/s3Upload.js";
import { archiveEmployeeDocument } from "../../utils/archiveEmployeeDocument.js";
import { triggerProfileReactivationIfNeeded, shouldQueueProfileChange } from "../../utils/triggerProfileReactivation.js";

const REQUIRED_FIELDS = ["number", "issueDate", "expiryDate"];

const normalizeDate = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

export const updatePassportDetails = async (req, res) => {
    const { id } = req.params;
    const {
        number,
        nationality,
        issueDate,
        expiryDate,
        placeOfIssue,
        passportCopy,
        passportCopyName,
        passportCopyMime,
    } = req.body || {};

    // Validate required fields
    const missingFields = REQUIRED_FIELDS.filter((field) => {
        const value = req.body[field];
        return value === undefined || value === null || (typeof value === 'string' && value.trim() === "");
    });

    if (missingFields.length > 0) {
        return res.status(400).json({
            message: "Missing required passport fields.",
            missingFields,
        });
    }

    // Validate dates
    const parsedIssueDate = normalizeDate(issueDate);
    const parsedExpiryDate = normalizeDate(expiryDate);

    if (!parsedIssueDate || !parsedExpiryDate) {
        return res.status(400).json({
            message: "Invalid issue or expiry date provided.",
        });
    }

    try {
        // Get employeeId from employee record using optimized resolver
        const employee = await resolveEmployeeId(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found." });
        }

        const employeeId = employee.employeeId;
        const employeeBasic = await EmployeeBasic.findOne({ employeeId }).select("company profileStatus profileWorkflow").lean();
        const requiresApprovalQueue = shouldQueueProfileChange(employeeBasic);

        // Fetch existing passport to handle renewal/archiving
        const existingPassport = await EmployeePassport.findOne({ employeeId });

        const hasExistingDocument = Boolean(existingPassport?.document?.url || existingPassport?.document?.data);
        const hasNewDocumentUpload = Boolean(passportCopy && typeof passportCopy === "string" && passportCopy.trim() !== "");
        const shouldArchivePrevious = !requiresApprovalQueue && hasExistingDocument && hasNewDocumentUpload;
        if (shouldArchivePrevious) {
            await archiveEmployeeDocument({
                employeeId,
                type: "Passport",
                description: existingPassport?.number ? `Passport No: ${existingPassport.number}` : "",
                issueDate: existingPassport?.issueDate || null,
                expiryDate: existingPassport?.expiryDate || null,
                document: existingPassport.document,
            });
        }

        // Handle document upload to IDrive (S3) if new document provided
        let documentData = undefined;
        if (passportCopy) {
            // Check if it's already a URL (IDrive or otherwise)
            if (passportCopy.startsWith('http://') || passportCopy.startsWith('https://')) {
                // Already a URL
                documentData = {
                    url: passportCopy,
                    name: passportCopyName || "",
                    mimeType: passportCopyMime || "",
                };
            } else {
                // Upload base64 to IDrive
                // Note: s3Upload utility handles base64 prefixes automatically
                const uploadResult = await uploadDocumentToS3(
                    passportCopy,
                    `employee-documents/${employeeId}/passport`,
                    passportCopyName || 'passport.pdf',
                    'raw'
                );

                // Delete old file only when it is not archived in oldDocuments.
                if (!shouldArchivePrevious && existingPassport?.document?.publicId) {
                    await deleteDocumentFromS3(existingPassport.document.publicId);
                }

                documentData = {
                    url: uploadResult.url,
                    publicId: uploadResult.publicId,
                    name: passportCopyName || "",
                    mimeType: passportCopyMime || "",
                };
            }
        } else {
            // Preserve existing document if no new one provided
            if (existingPassport?.document) {
                documentData = existingPassport.document;
            }
        }



        const passportPayload = {
            number: (typeof number === 'string' ? number.trim() : number) || "",
            nationality: (typeof nationality === 'string' ? nationality.trim() : nationality) || "",
            issueDate: parsedIssueDate,
            expiryDate: parsedExpiryDate,
            placeOfIssue: (typeof placeOfIssue === 'string' ? placeOfIssue.trim() : placeOfIssue) || "",
            document: documentData,
            lastUpdated: new Date(),
            passportExp: parsedExpiryDate, // Update expiry date for quick reference
        };

        // Always persist passport changes to DB.
        // If profile is in reactivation flow, we still store the record, but also track it for HR re-approval.
        const updatedPassport = await EmployeePassport.findOneAndUpdate(
            { employeeId },
            passportPayload,
            { upsert: true, new: true }
        );

        await triggerProfileReactivationIfNeeded({
            employeeId,
            actor: req.user,
            reason: "Passport details updated",
            changeEntry: requiresApprovalQueue
                ? {
                    card: "Passport",
                    reason: "Passport details updated",
                    section: "passport",
                    changeType: "update",
                    targetIndex: null,
                    previousData: existingPassport || null,
                    proposedData: passportPayload,
                }
                : null,
            trackDefaultChange: !requiresApprovalQueue,
        });
        const completeEmployee = await getCompleteEmployee(employeeId);

        return res.json({
            message: requiresApprovalQueue
                ? "Passport change queued for HR activation approval."
                : "Passport details updated successfully.",
            passportDetails: {
                number: updatedPassport?.number,
                nationality: updatedPassport?.nationality,
                issueDate: updatedPassport?.issueDate,
                expiryDate: updatedPassport?.expiryDate,
                placeOfIssue: updatedPassport?.placeOfIssue,
                document: updatedPassport?.document,
                lastUpdated: updatedPassport?.lastUpdated,
            },
            employee: completeEmployee
        });
    } catch (error) {
        console.error("Failed to update passport details:", error);
        return res.status(500).json({
            message: "Failed to update passport details.",
            error: error.message,
        });
    }
};

