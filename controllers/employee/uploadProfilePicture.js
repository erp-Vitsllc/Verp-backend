import { PutObjectCommand } from "@aws-sdk/client-s3";
import EmployeeBasic from '../../models/EmployeeBasic.js';
import { getCompleteEmployee, resolveEmployeeId } from '../../services/employeeService.js';
import s3Client, { bucketName } from '../../config/s3Client.js';
import { getSignedFileUrl } from '../../utils/s3Upload.js';
import { randomUUID } from 'crypto';
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";
import { skipLiveProfileWritesPendingHr, queueOrTriggerProfileChange } from "../../utils/pushPendingReactivationChange.js";

export const uploadProfilePicture = async (req, res) => {
    try {
        console.log('Upload profile picture endpoint hit (Wasabi S3)');
        const { id } = req.params;
        const { image } = req.body; // Base64 image string

        // 1. Validate Base64 image
        // 1. Validate Base64 image
        if (!image || typeof image !== 'string') {
            return res.status(400).json({ message: 'Image is required and must be a string' });
        }
        if (!image.startsWith('data:image/')) {
            return res.status(400).json({ message: 'Invalid image format' });
        }

        // 2. Resolve Employee
        const employee = await resolveEmployeeId(id);
        if (!employee) {
            return res.status(404).json({ message: 'Employee not found' });
        }
        const employeeId = employee.employeeId;

        // 3. Process Image
        // Remove header (e.g., "data:image/jpeg;base64,")
        const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');

        // Extract content type and extension
        const typeMatch = image.match(/^data:(image\/\w+);base64,/);
        const contentType = typeMatch ? typeMatch[1] : 'image/jpeg';
        const extension = contentType.split('/')[1] || 'jpg';

        // 4. Generate Filename & Key
        // Bucket folder: employee-profiles/
        const filename = `employee-profiles/${employeeId}-${randomUUID()}.${extension}`;

        // 5. Upload to Wasabi (S3-compatible)
        const uploadParams = {
            Bucket: bucketName,
            Key: filename,
            Body: buffer,
            ContentType: contentType,
            ACL: 'private'
        };

        await s3Client.send(new PutObjectCommand(uploadParams));

        const storageKey = filename;
        const signedUrl = await getSignedFileUrl(storageKey);

        const employeeBasic = await EmployeeBasic.findOne({ employeeId })
            .select("profilePicture profileStatus profileWorkflow profileApprovalStatus company")
            .lean();
        if (!employeeBasic) {
            return res.status(404).json({ message: "Employee not found during update" });
        }

        const skipLive = skipLiveProfileWritesPendingHr(employeeBasic, req.user);
        const previousPicture = employeeBasic.profilePicture || null;

        if (!skipLive) {
            await EmployeeBasic.findOneAndUpdate(
                { employeeId },
                { profilePicture: storageKey },
                { new: true, runValidators: true }
            );
            await triggerProfileReactivationIfNeeded({
                employeeId,
                actor: req.user,
                reason: "Profile picture updated",
                changeEntry: null,
                trackDefaultChange: true,
            });
        } else {
            await queueOrTriggerProfileChange({
                employeeId,
                actor: req.user,
                reason: "Profile picture updated",
                employeeBasic,
                changeEntry: {
                    card: "Profile picture",
                    reason: "Profile picture updated",
                    section: "basicDetails",
                    changeType: "update",
                    targetIndex: null,
                    previousData: { profilePicture: previousPicture },
                    proposedData: { profilePicture: storageKey },
                },
            });
        }
        const completeEmployee = await getCompleteEmployee(employeeId);
        if (completeEmployee) delete completeEmployee.password;

        return res.status(200).json({
            message: skipLive
                ? "Profile picture change queued for HR activation approval."
                : "Profile picture uploaded successfully",
            profilePicture: signedUrl || storageKey,
            queuedForHrApproval: !!skipLive,
            employee: completeEmployee
        });

    } catch (error) {
        console.error('Error uploading profile picture:', error);
        return res.status(500).json({
            message: error.message || 'Failed to upload profile picture'
        });
    }
};
