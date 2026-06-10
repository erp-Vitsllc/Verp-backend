import EmployeeBasic from "../../models/EmployeeBasic.js";
import { uploadDocumentToS3 } from "../../utils/s3Upload.js";
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";
import { shouldSkipLiveEmployeeSection, queueOrTriggerProfileChange } from "../../utils/pushPendingReactivationChange.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";
import { scheduleEmployeeProfileFileChangeHrEmailForRequest } from "../../utils/employeeInformativeHrNotify.js";
import { validateEmployeeSignaturePayload } from "../../utils/employeeSignatureValidation.js";
import { disposeEmployeeProfileAttachment } from "../../utils/profileAttachmentDisposition.js";

/**
 * Handle e-Signature upload and association with employee
 * Logic: Receives base64 PNG, uploads to S3, and updates EmployeeBasic record
 */
export const uploadSignature = async (req, res) => {
    const { id } = req.params;
    const { signatureData, fileName: reqFileName, signedAt } = req.body;

    if (!signatureData) {
        return res.status(400).json({ message: "No signature data provided." });
    }

    try {
        // 1. Verify employee exists
        const employee = await EmployeeBasic.findById(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found." });
        }
        const isAdminUser = await isReqUserAdmin(req.user);
        const skipLive = !isAdminUser && shouldSkipLiveEmployeeSection(employee, "signature", req.user);

        const signatureValidation = validateEmployeeSignaturePayload({
            signatureData,
            fileName: reqFileName,
            signedAt,
            dateOfJoining: employee.dateOfJoining,
        });
        if (!signatureValidation.ok) {
            return res.status(400).json({ message: signatureValidation.message });
        }

        const isDocument = !!reqFileName;
        const extension = reqFileName ? reqFileName.split('.').pop().toLowerCase() : 'png';
        if (extension === 'pdf') {
            return res.status(400).json({ message: "Only JPG, JPEG, and PNG formats are allowed" });
        }
        const fileName = reqFileName ? `signature_${Date.now()}_${reqFileName}` : `signature_${Date.now()}.png`;
        const resourceType = 'image';
        const parsedMimeType =
            (typeof signatureData === 'string' && signatureData.startsWith('data:') && signatureData.includes(';base64,'))
                ? signatureData.substring(5, signatureData.indexOf(';base64,'))
                : (isDocument ? 'application/pdf' : 'image/png');

        // 2. Upload to S3 (IDrive e2)
        const folder = `employee-signatures/${employee.employeeId}`;

        // uploadDocumentToS3 handles base64 cleaning and S3 transfer
        const result = await uploadDocumentToS3(signatureData, folder, fileName, resourceType);

        const proposedSignature = {
            url: result.publicId,
            publicId: result.publicId,
            name: reqFileName || 'Signature',
            mimeType: parsedMimeType,
            signedAt: signedAt ? new Date(signedAt) : new Date(),
            ipAddress: req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress,
            format: result.format || extension
        };
        const signatureChangeEntry = {
            card: "Digital Signature",
            reason: "Signature updated",
            section: "signature",
            changeType: "update",
            targetIndex: null,
            previousData: employee.signature || null,
            proposedData: proposedSignature,
        };

        if (employee.signature && !skipLive) {
            await disposeEmployeeProfileAttachment(req, {
                employeeBasic: employee,
                attachment: employee.signature,
                archive: {
                    moduleName: "Employee Signature",
                    recordId: employee.employeeId,
                    details: `Signature replaced for ${employee.employeeId}`,
                    deletedPayload: { employeeId: employee.employeeId, signature: employee.signature },
                },
            });
        }

        if (skipLive) {
            await queueOrTriggerProfileChange({
                employeeId: employee.employeeId,
                actor: req.user,
                reason: "Signature updated",
                employeeBasic: employee,
                changeEntry: signatureChangeEntry,
            });
        } else {
            employee.signature = proposedSignature;
            await employee.save();
            await triggerProfileReactivationIfNeeded({
                employeeId: employee.employeeId,
                actor: req.user,
                reason: "Signature updated",
                changeEntry: null,
                trackDefaultChange: true,
            });
        }

        scheduleEmployeeProfileFileChangeHrEmailForRequest({
            req,
            employeeId: employee.employeeId,
            employeeBasic: employee,
            sectionKey: "signature",
            sectionLabel: "Digital Signature",
            action: "edited",
            attachments: proposedSignature,
            actor: req.user,
            skipLive,
        });

        // 4. Return success (with fresh signed URL for display)
        return res.status(200).json({
            message: skipLive
                ? "Signature change queued for HR activation approval."
                : "Signature uploaded and saved successfully.",
            signatureUrl: result.url,
            signedAt: proposedSignature.signedAt,
            format: proposedSignature.format
        });

    } catch (error) {
        console.error("Signature upload error:", error);
        return res.status(500).json({
            message: "Failed to process signature. Please try again.",
            error: error.message
        });
    }
};
