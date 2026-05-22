import { resolveEmployeeId } from '../../services/employeeService.js';
import { uploadDocumentToS3 } from '../../utils/s3Upload.js';
import { randomUUID } from 'crypto';

/**
 * Upload document to IDrive e2 (S3 compatible)
 * This endpoint allows frontend to upload documents before saving employee data
 * This prevents blocking during save operations
 */
export const uploadDocument = async (req, res) => {
    try {
        const { id } = req.params;
        const { document, folder, fileName, resourceType } = req.body;

        if (!document) {
            return res.status(400).json({ message: 'Document data is required' });
        }

        // Validate that document is base64 encoded
        if (typeof document !== 'string') {
            return res.status(400).json({ message: 'Document must be a base64 encoded string' });
        }

        // Get employeeId for folder organization
        let employeeId = null;
        if (id) {
            const employee = await resolveEmployeeId(id);
            if (employee) {
                employeeId = employee.employeeId;
            }
        }

        // Build folder path if not provided
        const folderPath = folder || (employeeId ? `employee-documents/${employeeId}` : 'employee-documents');

        // Generate unique filename if not provided
        // Note: s3Upload utility handles extension inference, but if we want to pass a specific name we can
        // If fileName is provided, use it. If not, pass null to utility to let it generate ID+Ext

        // Upload to IDrive (S3) using shared utility
        const uploadResult = await uploadDocumentToS3(
            document,
            folderPath,
            fileName || null,
            resourceType || 'auto'
        );

        return res.status(200).json({
            success: true,
            url: uploadResult.url,
            publicId: uploadResult.publicId, // Use S3 key as publicId
            format: uploadResult.format,
            resourceType: uploadResult.resourceType
        });
    } catch (error) {
        console.error('Error uploading document to S3:', error);
        const message = error.message || 'Failed to upload document to storage';
        const isClientError =
            /only pdf|jpg|png|not allowed|no file data|must be a base64|invalid or empty/i.test(message);

        return res.status(isClientError ? 400 : 500).json({
            message,
            error: process.env.NODE_ENV === 'development' ? message : undefined,
        });
    }
};
