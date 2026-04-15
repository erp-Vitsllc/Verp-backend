import { PutObjectCommand } from "@aws-sdk/client-s3";
import EmployeeBasic from '../../models/EmployeeBasic.js';
import { getCompleteEmployee, resolveEmployeeId } from '../../services/employeeService.js';
import s3Client, { bucketName } from '../../config/s3Client.js';
import { randomUUID } from 'crypto';
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";

export const uploadProfilePicture = async (req, res) => {
    try {
        console.log('Upload profile picture endpoint hit (IDrive S3)');
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

        // 5. Upload to IDrive e2 (S3)
        const uploadParams = {
            Bucket: bucketName,
            Key: filename,
            Body: buffer,
            ContentType: contentType,
            ACL: 'private' // Private access, requires signed URL to view
            // No ServerSideEncryption or KMS keys specified
        };

        await s3Client.send(new PutObjectCommand(uploadParams));

        // 6. Construct Public URL (Virtual-hosted style)
        // Format: https://${bucketName}.s3.ap-southeast-1.idrivee2.com/${filename}
        const region = 'ap-southeast-1'; // Hardcoded as per your requirement/environment
        const baseDomain = 'idrivee2.com';

        // Ensure bucketName is clean
        const cleanBucketName = bucketName.trim();

        // The endpoint in your env is likely "s3.ap-southeast-1.idrivee2.com"
        // We will construct the Virtual Hosted URL manually as requested
        const publicUrl = `https://${cleanBucketName}.s3.${region}.${baseDomain}/${filename}`;

        console.log('Generated Public URL:', publicUrl);

        // 7. Update EmployeeBasic
        const updated = await EmployeeBasic.findOneAndUpdate(
            { employeeId },
            { profilePicture: publicUrl },
            { new: true, runValidators: true }
        ).select('-password');

        if (!updated) {
            return res.status(404).json({ message: 'Employee not found during update' });
        }

        // 8. Return Response
        await triggerProfileReactivationIfNeeded({
            employeeId,
            actor: req.user,
            reason: "Profile picture updated",
        });
        const completeEmployee = await getCompleteEmployee(employeeId);
        if (completeEmployee) delete completeEmployee.password;

        return res.status(200).json({
            message: 'Profile picture uploaded successfully',
            profilePicture: publicUrl,
            employee: completeEmployee
        });

    } catch (error) {
        console.error('Error uploading profile picture:', error);
        return res.status(500).json({
            message: error.message || 'Failed to upload profile picture'
        });
    }
};
