import EmployeePassport from "../../models/EmployeePassport.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { resolveEmployeeId, getCompleteEmployee } from "../../services/employeeService.js";
import { uploadDocumentToS3 } from "../../utils/s3Upload.js";
import { disposeEmployeeProfileAttachment } from "../../utils/profileAttachmentDisposition.js";
import { archiveAndClearLiveEmployeeRenewal, employeeRenewalHasExistingCard } from "../../utils/employeeDocumentRenewal.js";
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";
import { shouldSkipLiveEmployeeSectionAsync, queueOrTriggerProfileChange } from "../../utils/pushPendingReactivationChange.js";
import { markProfileActivationHoldResolvedForSection } from "../../utils/markProfileActivationHoldResolved.js";
import {
    normalizeEmployeePassportPayload,
    validateEmployeePassportPayload,
} from "../../utils/employeePassportValidation.js";
import { scheduleEmployeeProfileFileChangeHrEmailForRequest } from "../../utils/employeeInformativeHrNotify.js";

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

    try {
        // Get employeeId from employee record using optimized resolver
        const employee = await resolveEmployeeId(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found." });
        }

        const employeeId = employee.employeeId;
        const employeeBasic = await EmployeeBasic.findOne({ employeeId })
            .select("company profileStatus profileWorkflow profileApprovalStatus profileSubmittedTo")
            .lean();
        const skipLive = await shouldSkipLiveEmployeeSectionAsync(req, employeeBasic, "passport");
        const profileActive = String(employeeBasic?.profileStatus || "").toLowerCase() === "active";

        // Fetch existing passport to handle renewal/archiving
        const existingPassport = await EmployeePassport.findOne({ employeeId });

        const validationInput = normalizeEmployeePassportPayload({
            number,
            nationality,
            issueDate,
            expiryDate,
            placeOfIssue,
            document: passportCopy || existingPassport?.document,
            documentName: passportCopyName || existingPassport?.document?.name,
        });
        const validation = validateEmployeePassportPayload(validationInput, {
            profileActive,
            existingPassportNumber: existingPassport?.number || "",
        });
        if (!validation.ok) {
            return res.status(400).json({ message: validation.message });
        }

        const parsedIssueDate = normalizeDate(issueDate);
        const parsedExpiryDate = normalizeDate(expiryDate);

        if (!parsedIssueDate || !parsedExpiryDate) {
            return res.status(400).json({
                message: "Invalid issue or expiry date provided.",
            });
        }

        const isRenewal = req.body?.isRenewal === true;
        const hasExistingDocument = employeeRenewalHasExistingCard(existingPassport);
        const hasNewDocumentUpload = Boolean(passportCopy && typeof passportCopy === "string" && passportCopy.trim() !== "");
        const shouldArchivePrevious = await archiveAndClearLiveEmployeeRenewal({
            employeeId,
            skipLive,
            isRenewal,
            hasExistingDocument,
            hasNewDocumentUpload,
            section: "passport",
            archiveParams: {
                type: "Passport",
                description: existingPassport?.number ? `Passport No: ${existingPassport.number}` : "",
                issueDate: existingPassport?.issueDate || null,
                expiryDate: existingPassport?.expiryDate || null,
                document: existingPassport?.document,
            },
        });

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

                if (!shouldArchivePrevious && existingPassport?.document) {
                    await disposeEmployeeProfileAttachment(req, {
                        employeeBasic,
                        attachment: existingPassport.document,
                        isActivationDocumentChange: skipLive,
                        archive: {
                            moduleName: "Employee Passport Attachment",
                            recordId: employeeId,
                            details: `Passport attachment replaced for ${employeeId}`,
                            deletedPayload: { employeeId, passport: existingPassport },
                        },
                    });
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
            number: validationInput.number || "",
            nationality: validationInput.nationality || "",
            issueDate: parsedIssueDate,
            expiryDate: parsedExpiryDate,
            placeOfIssue: validationInput.placeOfIssue || "",
            document: documentData,
            lastUpdated: new Date(),
            passportExp: parsedExpiryDate, // Update expiry date for quick reference
        };

        let updatedPassport = existingPassport;
        if (!skipLive) {
            updatedPassport = await EmployeePassport.findOneAndUpdate(
                { employeeId },
                passportPayload,
                { upsert: true, new: true }
            );
        }

        const passportSnapshot = (doc) => {
            if (!doc) return null;
            const o = typeof doc.toObject === "function" ? doc.toObject() : doc;
            return {
                number: o.number || "",
                nationality: o.nationality || "",
                issueDate: o.issueDate || null,
                expiryDate: o.expiryDate || null,
                placeOfIssue: o.placeOfIssue || "",
                document: o.document || null,
            };
        };

        const passportChangeEntry = {
            card: "Passport",
            reason: "Passport details updated",
            section: "passport",
            changeType: "update",
            targetIndex: null,
            isRenewal,
            previousData: passportSnapshot(existingPassport),
            proposedData: passportSnapshot(passportPayload),
        };

        if (skipLive) {
            await queueOrTriggerProfileChange({
                employeeId,
                actor: req.user,
                reason: "Passport details updated",
                employeeBasic,
                changeEntry: passportChangeEntry,
            });
        } else {
            await triggerProfileReactivationIfNeeded({
                employeeId,
                actor: req.user,
                reason: "Passport details updated",
                changeEntry: null,
                trackDefaultChange: true,
            });
        }
        try {
            await markProfileActivationHoldResolvedForSection(employeeId, "passport");
        } catch (_e) {
            /* ignore */
        }
        const completeEmployee = await getCompleteEmployee(employeeId);

        scheduleEmployeeProfileFileChangeHrEmailForRequest({
            req,
            employeeId,
            employeeBasic,
            sectionKey: "passport",
            sectionLabel: "Passport",
            action: hasNewDocumentUpload && hasExistingDocument ? "renewed" : "edited",
            attachments: passportPayload?.document,
            actor: req.user,
            skipLive,
            isRenewal: req.body?.isRenewal === true,
        });

        return res.json({
            message: skipLive
                ? "Passport change queued for HR activation approval."
                : "Passport details updated successfully.",
            queuedForHrApproval: !!skipLive,
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

