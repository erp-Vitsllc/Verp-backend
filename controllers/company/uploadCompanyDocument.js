import { uploadDocumentToS3 } from "../../utils/s3Upload.js";

export const uploadCompanyDocument = async (req, res) => {
    try {
        const { id } = req.params; // Company ID (or mongo ID)
        const { fileData, fileName, folder } = req.body;

        if (!fileData || !fileName) {
            return res.status(400).json({ message: "File data and name are required" });
        }

        const folderPath = folder || `company-documents/${id}`;

        const uploadResult = await uploadDocumentToS3(
            fileData,
            folderPath,
            fileName
        );

        res.status(200).json({
            message: "Upload successful",
            url: uploadResult.url,
            key: uploadResult.publicId,
            publicId: uploadResult.publicId,
        });

    } catch (error) {
        console.error("Error uploading company document:", error);
        res.status(500).json({ message: "Upload failed", error: error.message });
    }
};
