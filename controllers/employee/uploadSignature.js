import EmployeeBasic from "../../models/EmployeeBasic.js";
import { uploadDocumentToS3 } from "../../utils/s3Upload.js";

/**
 * Handle e-Signature upload and association with employee
 * Logic: Receives base64 PNG, uploads to S3, and updates EmployeeBasic record
 */
export const uploadSignature = async (req, res) => {
    const { id } = req.params;
    const { signatureData, fileName: reqFileName } = req.body; // Expects base64 data string

    if (!signatureData) {
        return res.status(400).json({ message: "No signature data provided." });
    }

    try {
        // 1. Verify employee exists
        const employee = await EmployeeBasic.findById(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found." });
        }

        // Determine if it's an uploaded file or drawn signature
        const isDocument = !!reqFileName;
        const extension = reqFileName ? reqFileName.split('.').pop() : 'png';
        const fileName = reqFileName ? `signature_${Date.now()}_${reqFileName}` : `signature_${Date.now()}.png`;
        const resourceType = isDocument ? 'auto' : 'image';
        const parsedMimeType =
            (typeof signatureData === 'string' && signatureData.startsWith('data:') && signatureData.includes(';base64,'))
                ? signatureData.substring(5, signatureData.indexOf(';base64,'))
                : (isDocument ? 'application/pdf' : 'image/png');

        // 2. Upload to S3 (IDrive e2)
        const folder = `employee-signatures/${employee.employeeId}`;

        // uploadDocumentToS3 handles base64 cleaning and S3 transfer
        const result = await uploadDocumentToS3(signatureData, folder, fileName, resourceType);

        // 3. Update Employee Record
        // We store the publicId (S3 Key) and metadata
        employee.signature = {
            url: result.publicId,
            publicId: result.publicId,
            name: reqFileName || 'Signature',
            mimeType: parsedMimeType,
            signedAt: new Date(),
            ipAddress: req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress,
            format: result.format || extension
        };

        await employee.save();

        // 4. Return success (with fresh signed URL for display)
        return res.status(200).json({
            message: "Signature uploaded and saved successfully.",
            signatureUrl: result.url,
            signedAt: employee.signature.signedAt,
            format: employee.signature.format
        });

    } catch (error) {
        console.error("Signature upload error:", error);
        return res.status(500).json({
            message: "Failed to process signature. Please try again.",
            error: error.message
        });
    }
};
