import { PutObjectCommand } from "@aws-sdk/client-s3";
import User from '../../models/User.js';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import s3Client, { bucketName } from '../../config/s3Client.js';
import { getSignedFileUrl } from '../../utils/s3Upload.js';
import { randomUUID } from 'crypto';

export const uploadUserProfilePicture = async (req, res) => {
    try {
        const { id } = req.params;
        const { image } = req.body; // Base64 image string

        if (!image || typeof image !== 'string') {
            return res.status(400).json({ message: 'Image is required and must be a string' });
        }
        if (!image.startsWith('data:image/')) {
            return res.status(400).json({ message: 'Invalid image format' });
        }

        const user = await User.findById(id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Process Base64
        const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');
        const typeMatch = image.match(/^data:(image\/\w+);base64,/);
        const contentType = typeMatch ? typeMatch[1] : 'image/jpeg';
        const extension = contentType.split('/')[1] || 'jpg';

        const filename = `user-profiles/${user.username}-${randomUUID()}.${extension}`;

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

        user.profilePicture = storageKey;
        await user.save();

        if (user.employeeId) {
            await EmployeeBasic.findOneAndUpdate(
                { employeeId: user.employeeId },
                { profilePicture: storageKey }
            );
        }

        return res.status(200).json({
            message: 'Profile picture uploaded successfully',
            profilePicture: signedUrl || storageKey
        });

    } catch (error) {
        console.error('Error uploading user profile picture:', error);
        return res.status(500).json({
            message: error.message || 'Failed to upload profile picture'
        });
    }
};
