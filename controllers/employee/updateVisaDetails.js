import EmployeeVisa from "../../models/EmployeeVisa.js";
import { resolveEmployeeId, getCompleteEmployee } from "../../services/employeeService.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { uploadDocumentToS3 } from "../../utils/s3Upload.js";
import { disposeEmployeeProfileAttachment } from "../../utils/profileAttachmentDisposition.js";
import { archiveAndClearLiveEmployeeRenewal } from "../../utils/employeeDocumentRenewal.js";
import { markProfileActivationHoldResolvedForSection } from "../../utils/markProfileActivationHoldResolved.js";
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";
import { shouldSkipLiveEmployeeSectionAsync, queueOrTriggerProfileChange } from "../../utils/pushPendingReactivationChange.js";
import {
    normalizeEmployeeVisaPayload,
    validateEmployeeVisaPayload,
} from "../../utils/employeeVisaValidation.js";
import { scheduleEmployeeProfileFileChangeHrEmailForRequest } from "../../utils/employeeInformativeHrNotify.js";

const ALLOWED_VISA_TYPES = ["visit", "employment", "spouse"];

const VISA_LABELS = {
    visit: "Visit Visa",
    employment: "Employment Visa",
    spouse: "Third Party",
};

const normalizeDate = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

export const updateVisaDetails = async (req, res) => {
    const { id } = req.params;
    const {
        visaType,
        visaNumber,
        issueDate,
        expiryDate,
        sponsor,
        visaCopy,
        visaCopyName,
        visaCopyMime,
    } = req.body || {};

    if (visaNumber !== undefined && typeof visaNumber !== "string") {
        return res.status(400).json({ message: "Visa number must be a string" });
    }
    if (visaCopy !== undefined && typeof visaCopy !== "string") {
        return res.status(400).json({ message: "Visa copy must be a string (base64 or URL)" });
    }

    if (!visaType || !ALLOWED_VISA_TYPES.includes(visaType)) {
        return res.status(400).json({ message: "Invalid visa type provided." });
    }

    try {
        const employee = await resolveEmployeeId(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found." });
        }
        const employeeId = employee.employeeId;
        const employeeBasic = await EmployeeBasic.findOne({ employeeId })
            .select("company profileStatus status profileWorkflow profileApprovalStatus")
            .lean();
        const skipLive = await shouldSkipLiveEmployeeSectionAsync(req, employeeBasic, "visa");

        const existingVisa = await EmployeeVisa.findOne({ employeeId });
        const existingDocument = existingVisa?.[visaType]?.document?.url || existingVisa?.[visaType]?.document?.data;

        const lockedVisaNumber = String(existingVisa?.[visaType]?.number || "").trim();
        const validationInput = normalizeEmployeeVisaPayload(
            {
                number: lockedVisaNumber || visaNumber,
                issueDate,
                expiryDate,
                sponsor,
                document: visaCopy || existingVisa?.[visaType]?.document,
                documentName: visaCopyName || existingVisa?.[visaType]?.document?.name,
            },
            visaType,
        );
        const validation = await validateEmployeeVisaPayload(validationInput, {
            visaType,
            employeeId,
            existingVisaNumber: existingVisa?.[visaType]?.number || "",
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

        const previousVisaEntry = existingVisa?.[visaType];
        const isRenewal = req.body?.isRenewal === true;
        const hasExistingDocument = Boolean(previousVisaEntry?.document?.url || previousVisaEntry?.document?.data);
        const hasNewDocumentUpload = Boolean(visaCopy && typeof visaCopy === "string" && visaCopy.trim() !== "");
        const shouldArchivePrevious = await archiveAndClearLiveEmployeeRenewal({
            employeeId,
            skipLive,
            isRenewal,
            hasExistingDocument,
            hasNewDocumentUpload,
            section: "visa",
            visaType,
            archiveParams: {
                type: `${visaType.charAt(0).toUpperCase() + visaType.slice(1)} Visa`,
                description: previousVisaEntry?.number ? `Visa No: ${previousVisaEntry.number}` : "",
                issueDate: previousVisaEntry?.issueDate || null,
                expiryDate: previousVisaEntry?.expiryDate || null,
                document: previousVisaEntry?.document,
            },
        });

        let documentData = undefined;
        if (visaCopy && typeof visaCopy === "string" && visaCopy.trim() !== "") {
            if (visaCopy.startsWith("http://") || visaCopy.startsWith("https://")) {
                documentData = {
                    url: visaCopy,
                    name: visaCopyName || "",
                    mimeType: visaCopyMime || "",
                };
            } else {
                const uploadResult = await uploadDocumentToS3(
                    visaCopy,
                    `employee-documents/${employeeId}/visa/${visaType}`,
                    visaCopyName || `${visaType}-visa.pdf`,
                    "raw",
                );

                if (!shouldArchivePrevious && existingVisa?.[visaType]?.document) {
                    await disposeEmployeeProfileAttachment(req, {
                        employeeBasic,
                        attachment: existingVisa[visaType].document,
                        isActivationDocumentChange: skipLive,
                        archive: {
                            moduleName: `Employee Visa (${visaType}) Attachment`,
                            recordId: employeeId,
                            details: `${visaType} visa attachment replaced for ${employeeId}`,
                            deletedPayload: {
                                employeeId,
                                visaType,
                                visa: existingVisa[visaType],
                            },
                        },
                    });
                }

                documentData = {
                    url: uploadResult.url,
                    publicId: uploadResult.publicId,
                    name: visaCopyName || "",
                    mimeType: visaCopyMime || "",
                };
            }
        } else {
            documentData = existingVisa?.[visaType]?.document || undefined;
        }

        const visaPayload = {
            visaType,
            number: validationInput.number,
            issueDate: parsedIssueDate,
            expiryDate: parsedExpiryDate,
            sponsor: validationInput.sponsor || "",
            document: documentData,
            lastUpdated: new Date(),
        };

        let updatedVisa = existingVisa;
        if (!skipLive) {
            updatedVisa = await EmployeeVisa.findOneAndUpdate(
                { employeeId },
                {
                    $set: {
                        [visaType]: {
                            number: visaPayload.number,
                            issueDate: visaPayload.issueDate,
                            expiryDate: visaPayload.expiryDate,
                            sponsor: visaPayload.sponsor,
                            document: visaPayload.document,
                            lastUpdated: visaPayload.lastUpdated,
                        },
                    },
                },
                { upsert: true, new: true },
            );

            const expiryCheck = new Date(parsedExpiryDate);
            const todayCheck = new Date();
            expiryCheck.setHours(0, 0, 0, 0);
            todayCheck.setHours(0, 0, 0, 0);

            if (expiryCheck <= todayCheck) {
                await EmployeeBasic.updateOne(
                    { employeeId, status: "Active" },
                    { $set: { status: "Inactive" } },
                );
            }
        }

        const visaChangeEntry = {
            card: VISA_LABELS[visaType] || "Visa",
            reason: "Visa details updated",
            section: "visa",
            changeType: "update",
            targetIndex: null,
            isRenewal,
            previousData: previousVisaEntry
                ? { visaType, ...previousVisaEntry.toObject?.() || previousVisaEntry }
                : null,
            proposedData: visaPayload,
        };

        if (skipLive) {
            await queueOrTriggerProfileChange({
                employeeId,
                actor: req.user,
                reason: "Visa details updated",
                employeeBasic,
                changeEntry: visaChangeEntry,
            });
        } else {
            await triggerProfileReactivationIfNeeded({
                employeeId,
                actor: req.user,
                reason: "Visa details updated",
                changeEntry: null,
                trackDefaultChange: true,
            });
        }

        try {
            await markProfileActivationHoldResolvedForSection(employeeId, "visa");
        } catch (_e) {
            /* non-fatal */
        }

        const completeEmployee = await getCompleteEmployee(employeeId);

        scheduleEmployeeProfileFileChangeHrEmailForRequest({
            req,
            employeeId,
            employeeBasic,
            sectionKey: "visa",
            sectionLabel: VISA_LABELS[visaType] || "Visa",
            action: hasNewDocumentUpload && hasExistingDocument ? "renewed" : "edited",
            attachments: visaPayload?.document,
            actor: req.user,
            skipLive,
            isRenewal: req.body?.isRenewal === true,
        });

        return res.json({
            message: skipLive
                ? "Visa change queued for HR activation approval."
                : `${VISA_LABELS[visaType] || visaType} details updated successfully.`,
            queuedForHrApproval: !!skipLive,
            visaDetails: {
                visit: updatedVisa?.visit,
                employment: updatedVisa?.employment,
                spouse: updatedVisa?.spouse,
            },
            employee: completeEmployee,
        });
    } catch (error) {
        console.error("Failed to update visa details:", error);
        return res.status(500).json({
            message: "Failed to update visa details.",
            error: error.message,
        });
    }
};
