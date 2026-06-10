import EmployeeDrivingLicense from "../../models/EmployeeDrivingLicense.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { resolveEmployeeId, getCompleteEmployee } from "../../services/employeeService.js";
import { uploadDocumentToS3 } from "../../utils/s3Upload.js";
import { disposeEmployeeProfileAttachment } from "../../utils/profileAttachmentDisposition.js";
import { archiveAndClearLiveEmployeeRenewal } from "../../utils/employeeDocumentRenewal.js";
import { markProfileActivationHoldResolvedForSection } from "../../utils/markProfileActivationHoldResolved.js";
import {
    normalizeEmployeeDrivingLicensePayload,
    validateEmployeeDrivingLicensePayload,
} from "../../utils/employeeDrivingLicenseValidation.js";
import { scheduleEmployeeProfileFileChangeHrEmailForRequest } from "../../utils/employeeInformativeHrNotify.js";

const normalizeDocumentInput = (document) => {
    if (typeof document === "string") return document.trim();
    if (document && typeof document === "object") {
        if (typeof document.url === "string" && document.url.trim() !== "") return document.url.trim();
        if (typeof document.data === "string" && document.data.trim() !== "") return document.data.trim();
    }
    return "";
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

    if (number !== undefined && typeof number !== "string") {
        return res.status(400).json({ message: "License number must be a string" });
    }
    const normalizedDocument = normalizeDocumentInput(document);
    if (document !== undefined && typeof document !== "string" && typeof document !== "object") {
        return res.status(400).json({ message: "Document must be a string or an object containing url/data" });
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

        const existingDrivingLicense = await EmployeeDrivingLicense.findOne({ employeeId });
        const validationInput = normalizeEmployeeDrivingLicensePayload({
            number,
            issueDate,
            expiryDate,
            document: normalizedDocument || existingDrivingLicense?.drivingLicenceDetails?.document,
            documentName: documentName || existingDrivingLicense?.drivingLicenceDetails?.document?.name,
        });
        const validation = await validateEmployeeDrivingLicensePayload(validationInput, {
            employeeId,
            existingLicenseNumber: existingDrivingLicense?.drivingLicenceDetails?.number || "",
        });
        if (!validation.ok) {
            return res.status(400).json({ message: validation.message });
        }

        const parsedIssueDate = normalizeDate(issueDate);
        const parsedExpiryDate = normalizeDate(expiryDate);
        if (!parsedIssueDate || !parsedExpiryDate) {
            return res.status(400).json({ message: "Invalid issue or expiry date provided." });
        }

        const previousDrivingLicense = existingDrivingLicense?.drivingLicenceDetails;
        const isRenewal = req.body?.isRenewal === true;
        const hasExistingDocument = Boolean(previousDrivingLicense?.document?.url || previousDrivingLicense?.document?.data);
        const hasNewDocumentUpload = Boolean(normalizedDocument);
        const shouldArchivePrevious = await archiveAndClearLiveEmployeeRenewal({
            employeeId,
            skipLive: false,
            isRenewal,
            hasExistingDocument,
            hasNewDocumentUpload,
            section: "drivinglicense",
            archiveParams: {
                type: "Driving License",
                description: previousDrivingLicense?.number ? `License No: ${previousDrivingLicense.number}` : "",
                issueDate: previousDrivingLicense?.issueDate || null,
                expiryDate: previousDrivingLicense?.expiryDate || null,
                document: previousDrivingLicense?.document,
            },
        });

        let documentData = undefined;
        if (normalizedDocument) {
            if (normalizedDocument.startsWith("http://") || normalizedDocument.startsWith("https://")) {
                documentData = {
                    url: normalizedDocument,
                    name: documentName || "",
                    mimeType: documentMime || "",
                };
            } else {
                const uploadResult = await uploadDocumentToS3(
                    normalizedDocument,
                    `employee-documents/${employeeId}/driving-license`,
                    documentName || "driving-license.pdf",
                    "raw",
                );
                if (!shouldArchivePrevious && existingDrivingLicense?.drivingLicenceDetails?.document) {
                    await disposeEmployeeProfileAttachment(req, {
                        employeeBasic,
                        attachment: existingDrivingLicense.drivingLicenceDetails.document,
                        archive: {
                            moduleName: "Employee Driving License Attachment",
                            recordId: employeeId,
                            details: `Driving license attachment replaced for ${employeeId}`,
                            deletedPayload: {
                                employeeId,
                                drivingLicense: existingDrivingLicense.drivingLicenceDetails,
                            },
                        },
                    });
                }
                documentData = {
                    url: uploadResult.url,
                    publicId: uploadResult.publicId,
                    name: documentName || "",
                    mimeType: documentMime || "",
                };
            }
        } else {
            documentData = existingDrivingLicense?.drivingLicenceDetails?.document || undefined;
        }

        const drivingLicensePayload = {
            number: validationInput.number,
            issueDate: parsedIssueDate,
            expiryDate: parsedExpiryDate,
            document: documentData,
            lastUpdated: new Date(),
        };

        const updatedDrivingLicense = await EmployeeDrivingLicense.findOneAndUpdate(
            { employeeId },
            { $set: { drivingLicenceDetails: drivingLicensePayload } },
            { upsert: true, new: true },
        );

        try {
            await markProfileActivationHoldResolvedForSection(employeeId, "drivingLicense");
        } catch (_e) {
            /* non-fatal */
        }

        const completeEmployee = await getCompleteEmployee(employeeId);

        scheduleEmployeeProfileFileChangeHrEmailForRequest({
            req,
            employeeId,
            employeeBasic,
            sectionKey: "drivingLicense",
            sectionLabel: "Driving License",
            action: hasNewDocumentUpload && hasExistingDocument ? "renewed" : "edited",
            attachments: drivingLicensePayload?.document,
            actor: req.user,
            skipLive: false,
            isRenewal: req.body?.isRenewal === true,
        });

        return res.json({
            message: "Driving License details updated successfully.",
            drivingLicenceDetails: updatedDrivingLicense?.drivingLicenceDetails || completeEmployee?.drivingLicenceDetails,
            employee: completeEmployee,
        });
    } catch (error) {
        console.error("Failed to update Driving License details:", error);
        return res.status(500).json({
            message: "Failed to update Driving License details.",
            error: error.message,
        });
    }
};
