import EmployeeVisa from "../../models/EmployeeVisa.js";
import { resolveEmployeeId, getCompleteEmployee } from "../../services/employeeService.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { uploadDocumentToS3, deleteDocumentFromS3 } from "../../utils/s3Upload.js";
import { archiveEmployeeDocument } from "../../utils/archiveEmployeeDocument.js";
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";
import { skipLiveProfileWritesPendingHr, queueOrTriggerProfileChange } from "../../utils/pushPendingReactivationChange.js";

const ALLOWED_VISA_TYPES = ["visit", "employment", "spouse"];

const REQUIRED_FIELDS_BY_TYPE = {
    visit: ["visaNumber", "issueDate", "expiryDate", "visaCopy"],
    employment: ["visaNumber", "issueDate", "expiryDate", "visaCopy", "sponsor"],
    spouse: ["visaNumber", "issueDate", "expiryDate", "visaCopy", "sponsor"],
};

const buildMissingFields = (body, visaType, existingDocument) => {
    const required = REQUIRED_FIELDS_BY_TYPE[visaType] || [];
    return required.filter((field) => {
        if (field === "visaCopy") {
            // Check if visaCopy is provided OR if existing document exists in DB
            const hasVisaCopy = body.visaCopy && typeof body.visaCopy === 'string' && body.visaCopy.trim() !== '';
            return !hasVisaCopy && !existingDocument;
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

    // Type validation
    if (visaNumber !== undefined && typeof visaNumber !== 'string') {
        return res.status(400).json({ message: "Visa number must be a string" });
    }
    if (visaCopy !== undefined && typeof visaCopy !== 'string') {
        return res.status(400).json({ message: "Visa copy must be a string (base64 or URL)" });
    }

    if (!visaType || !ALLOWED_VISA_TYPES.includes(visaType)) {
        return res.status(400).json({ message: "Invalid visa type provided." });
    }

    try {
        // Get employeeId first to check for existing documents
        const employee = await resolveEmployeeId(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found." });
        }
        const employeeId = employee.employeeId;
        const employeeBasic = await EmployeeBasic.findOne({ employeeId })
            .select("company profileStatus status profileWorkflow profileApprovalStatus")
            .lean();
        const skipLive = skipLiveProfileWritesPendingHr(employeeBasic);

        // Check if existing document exists in database (check for both url and data for backward compatibility)
        const existingVisa = await EmployeeVisa.findOne({ employeeId });
        const existingDocument = existingVisa?.[visaType]?.document?.url || existingVisa?.[visaType]?.document?.data;

        const missingFields = buildMissingFields(
            { visaNumber, issueDate, expiryDate, sponsor, visaCopy },
            visaType,
            existingDocument
        );
        if (missingFields.length > 0) {
            return res.status(400).json({
                message: "Missing required visa fields.",
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

        const previousVisaEntry = existingVisa?.[visaType];
        const hasExistingDocument = Boolean(previousVisaEntry?.document?.url || previousVisaEntry?.document?.data);
        const hasNewDocumentUpload = Boolean(visaCopy && typeof visaCopy === "string" && visaCopy.trim() !== "");
        const shouldArchivePrevious = !skipLive && hasExistingDocument && hasNewDocumentUpload;
        if (shouldArchivePrevious) {
            await archiveEmployeeDocument({
                employeeId,
                type: `${visaType.charAt(0).toUpperCase() + visaType.slice(1)} Visa`,
                description: previousVisaEntry?.number ? `Visa No: ${previousVisaEntry.number}` : "",
                issueDate: previousVisaEntry?.issueDate || null,
                expiryDate: previousVisaEntry?.expiryDate || null,
                document: previousVisaEntry.document,
            });
        }

        // Handle document upload to IDrive (S3) if new document provided
        let documentData = undefined;
        if (visaCopy && typeof visaCopy === 'string' && visaCopy.trim() !== '') {
            // Check if it's already a URL (IDrive or otherwise)
            if (visaCopy.startsWith('http://') || visaCopy.startsWith('https://')) {
                // Already a URL
                documentData = {
                    url: visaCopy,
                    name: visaCopyName || "",
                    mimeType: visaCopyMime || "",
                };
            } else {
                // Upload base64 to IDrive
                const uploadResult = await uploadDocumentToS3(
                    visaCopy,
                    `employee-documents/${employeeId}/visa/${visaType}`,
                    visaCopyName || `${visaType}-visa.pdf`,
                    'raw'
                );

                // Delete old file only when it is not archived in oldDocuments.
                if (!shouldArchivePrevious && existingVisa?.[visaType]?.document?.publicId) {
                    await deleteDocumentFromS3(existingVisa[visaType].document.publicId);
                }

                documentData = {
                    url: uploadResult.url,
                    publicId: uploadResult.publicId,
                    name: visaCopyName || "",
                    mimeType: visaCopyMime || "",
                };
            }
        } else {
            // Preserve existing document if no new one provided
            documentData = existingVisa?.[visaType]?.document || undefined;
        }

        // Build visa payload - preserve existing document if no new one provided
        const visaPayload = {
            number: visaNumber,
            issueDate: parsedIssueDate,
            expiryDate: parsedExpiryDate,
            sponsor: sponsor || "",
            document: documentData,
            lastUpdated: new Date(),
        };

        let updatedVisa = existingVisa;
        if (!skipLive) {
            updatedVisa = await EmployeeVisa.findOneAndUpdate(
                { employeeId },
                {
                    $set: {
                        [visaType]: visaPayload,
                    },
                },
                { upsert: true, new: true }
            );
        }

        const visaChangeEntry = {
            card: `${visaType} Visa`,
            reason: `${visaType} visa details updated`,
            section: "visa",
            changeType: "update",
            targetIndex: null,
            previousData: existingVisa?.[visaType] || null,
            proposedData: { visaType, ...visaPayload },
        };

        if (skipLive) {
            await queueOrTriggerProfileChange({
                employeeId,
                actor: req.user,
                reason: `${visaType} visa details updated`,
                employeeBasic,
                changeEntry: visaChangeEntry,
            });
        } else {
            await triggerProfileReactivationIfNeeded({
                employeeId,
                actor: req.user,
                reason: `${visaType} visa details updated`,
                changeEntry: null,
                trackDefaultChange: true,
            });
        }

        // Check for Visa Expiry and Update Status
        const expiryCheck = new Date(parsedExpiryDate);
        const todayCheck = new Date();
        expiryCheck.setHours(0, 0, 0, 0);
        todayCheck.setHours(0, 0, 0, 0);

        if (!skipLive && expiryCheck <= todayCheck) {
            // If the visa being updated is expired, set employee status to Inactive
            // Only update if currently 'Active' to avoid overwriting other statuses like 'Terminated' or 'Resigned'
            await EmployeeBasic.updateOne(
                { employeeId: employeeId, status: 'Active' },
                { $set: { status: 'Inactive' } }
            );
        }

        const completeEmployee = await getCompleteEmployee(employeeId);

        return res.json({
            message: skipLive
                ? `${visaType} visa change queued for HR activation approval.`
                : `${visaType} visa details updated successfully.`,
            visaDetails: {
                visit: updatedVisa?.visit,
                employment: updatedVisa?.employment,
                spouse: updatedVisa?.spouse,
            },
            employee: completeEmployee
        });
    } catch (error) {
        console.error("Failed to update visa details:", error);
        return res.status(500).json({
            message: "Failed to update visa details.",
            error: error.message,
        });
    }
};



