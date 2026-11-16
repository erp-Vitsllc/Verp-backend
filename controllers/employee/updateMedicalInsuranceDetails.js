import EmployeeMedicalInsurance from "../../models/EmployeeMedicalInsurance.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { resolveEmployeeId, getCompleteEmployee } from "../../services/employeeService.js";
import { uploadDocumentToS3 } from "../../utils/s3Upload.js";
import { disposeEmployeeProfileAttachment } from "../../utils/profileAttachmentDisposition.js";
import { archiveAndClearLiveEmployeeRenewal, employeeRenewalHasExistingCard } from "../../utils/employeeDocumentRenewal.js";
import { markProfileActivationHoldResolvedForSection } from "../../utils/markProfileActivationHoldResolved.js";
import {
    normalizeEmployeeMedicalInsurancePayload,
    validateEmployeeMedicalInsurancePayload,
} from "../../utils/employeeMedicalInsuranceValidation.js";
import { scheduleEmployeeProfileFileChangeHrEmailForRequest } from "../../utils/employeeInformativeHrNotify.js";
import {
    queueOrTriggerProfileChange,
    skipLiveProfileWritesPendingHrAsync,
} from "../../utils/pushPendingReactivationChange.js";
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";

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

    if (provider !== undefined && typeof provider !== "string") {
        return res.status(400).json({ message: "Provider must be a string" });
    }
    const normalizedUpload = normalizeUploadInput(upload);
    if (upload !== undefined && typeof upload !== "string" && typeof upload !== "object") {
        return res.status(400).json({ message: "Upload must be a string or an object containing url/data" });
    }

    try {
        const employee = await resolveEmployeeId(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found." });
        }

        const employeeId = employee.employeeId;
        const employeeBasic = await EmployeeBasic.findOne({ employeeId })
            .select("company profileStatus profileWorkflow profileApprovalStatus")
            .lean();

        const existingMedicalInsurance = await EmployeeMedicalInsurance.findOne({ employeeId });
        const validationInput = normalizeEmployeeMedicalInsurancePayload({
            provider,
            number,
            issueDate,
            expiryDate,
            document: normalizedUpload || existingMedicalInsurance?.medicalInsurance?.document,
            documentName: uploadName || existingMedicalInsurance?.medicalInsurance?.document?.name,
        });
        const validation = validateEmployeeMedicalInsurancePayload(validationInput);
        if (!validation.ok) {
            return res.status(400).json({ message: validation.message });
        }

        const parsedIssueDate = normalizeDate(issueDate);
        const parsedExpiryDate = normalizeDate(expiryDate);
        if (!parsedIssueDate || !parsedExpiryDate) {
            return res.status(400).json({ message: "Invalid issue or expiry date provided." });
        }

        const skipLive = await skipLiveProfileWritesPendingHrAsync(req, employeeBasic);
        const previousMedicalInsurance = existingMedicalInsurance?.medicalInsurance;
        const isRenewal = req.body?.isRenewal === true;
        const hasExistingDocument = employeeRenewalHasExistingCard(previousMedicalInsurance);
        const hasNewDocumentUpload = Boolean(normalizedUpload);
        const shouldArchivePrevious = await archiveAndClearLiveEmployeeRenewal({
            employeeId,
            skipLive,
            isRenewal,
            hasExistingDocument,
            hasNewDocumentUpload,
            section: "medicalinsurance",
            archiveParams: {
                type: "Medical Insurance",
                description: previousMedicalInsurance?.number
                    ? `Policy No: ${previousMedicalInsurance.number}`
                    : (previousMedicalInsurance?.provider || ""),
                issueDate: previousMedicalInsurance?.issueDate || null,
                expiryDate: previousMedicalInsurance?.expiryDate || null,
                document: previousMedicalInsurance?.document,
            },
        });

        let documentData = undefined;
        if (normalizedUpload) {
            if (normalizedUpload.startsWith("http://") || normalizedUpload.startsWith("https://")) {
                documentData = {
                    url: normalizedUpload,
                    name: uploadName || "",
                    mimeType: uploadMime || "",
                };
            } else {
                const uploadResult = await uploadDocumentToS3(
                    normalizedUpload,
                    `employee-documents/${employeeId}/medical-insurance`,
                    uploadName || "medical-insurance.pdf",
                    "raw",
                );
                if (!shouldArchivePrevious && existingMedicalInsurance?.medicalInsurance?.document) {
                    await disposeEmployeeProfileAttachment(req, {
                        employeeBasic,
                        isActivationDocumentChange: skipLive,
                        attachment: existingMedicalInsurance.medicalInsurance.document,
                        archive: {
                            moduleName: "Employee Medical Insurance Attachment",
                            recordId: employeeId,
                            details: `Medical insurance attachment replaced for ${employeeId}`,
                            deletedPayload: {
                                employeeId,
                                medicalInsurance: existingMedicalInsurance.medicalInsurance,
                            },
                        },
                    });
                }
                documentData = {
                    url: uploadResult.url,
                    publicId: uploadResult.publicId,
                    name: uploadName || "",
                    mimeType: uploadMime || "",
                };
            }
        } else {
            documentData = existingMedicalInsurance?.medicalInsurance?.document || undefined;
        }

        const medicalInsurancePayload = {
            provider: validationInput.provider,
            number: validationInput.number,
            issueDate: parsedIssueDate,
            expiryDate: parsedExpiryDate,
            document: documentData,
            lastUpdated: new Date(),
        };

        let updatedMedicalInsurance = existingMedicalInsurance;
        if (!skipLive) {
            updatedMedicalInsurance = await EmployeeMedicalInsurance.findOneAndUpdate(
                { employeeId },
                { $set: { medicalInsurance: medicalInsurancePayload } },
                { upsert: true, new: true },
            );
        }

        const medicalChangeEntry = {
            card: "Medical Insurance",
            reason: "Medical Insurance details updated",
            section: "medicalInsurance",
            changeType: "update",
            targetIndex: null,
            isRenewal,
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

        if (!skipLive) {
            try {
                const { reconcileEmployeeDocumentExpiryDashboard } = await import(
                    "../../utils/processDocumentExpiryReminders.js"
                );
                await reconcileEmployeeDocumentExpiryDashboard(employeeBasic?._id || employeeId);
            } catch (reconcileErr) {
                console.warn(
                    "[updateMedicalInsuranceDetails] reconcileEmployeeDocumentExpiryDashboard:",
                    reconcileErr?.message || reconcileErr,
                );
            }
        }

        scheduleEmployeeProfileFileChangeHrEmailForRequest({
            req,
            employeeId,
            employeeBasic,
            sectionKey: "medicalInsurance",
            sectionLabel: "Medical Insurance",
            action: hasNewDocumentUpload && hasExistingDocument ? "renewed" : "edited",
            attachments: medicalInsurancePayload?.document,
            actor: req.user,
            skipLive,
            isRenewal: req.body?.isRenewal === true,
        });

        return res.json({
            message: skipLive
                ? "Medical Insurance change queued for HR activation approval."
                : "Medical Insurance details updated successfully.",
            queuedForHrApproval: !!skipLive,
            medicalInsuranceDetails: updatedMedicalInsurance?.medicalInsurance || completeEmployee?.medicalInsuranceDetails,
            employee: completeEmployee,
        });
    } catch (error) {
        console.error("Failed to update Medical Insurance details:", error);
        return res.status(500).json({
            message: "Failed to update Medical Insurance details.",
            error: error.message,
        });
    }
};
