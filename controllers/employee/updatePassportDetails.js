import EmployeePassport from "../../models/EmployeePassport.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { resolveEmployeeId, getCompleteEmployee } from "../../services/employeeService.js";
import { uploadDocumentToS3, deleteDocumentFromS3 } from "../../utils/s3Upload.js";

const REQUIRED_FIELDS = ["number", "issueDate", "expiryDate"];

const normalizeDate = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

export const updatePassportDetails = async (req, res) => {
    const { id } = req.params;
    const {
        number,
        nationality,
        issueDate,
        expiryDate,
        placeOfIssue,
        passportCopy,
        passportCopyName,
        passportCopyMime,
        isRenewal, // Check for renewal flag
    } = req.body || {};

    // Validate required fields
    const missingFields = REQUIRED_FIELDS.filter((field) => {
        const value = req.body[field];
        return value === undefined || value === null || (typeof value === 'string' && value.trim() === "");
    });

    if (missingFields.length > 0) {
        return res.status(400).json({
            message: "Missing required passport fields.",
            missingFields,
        });
    }

    // Validate dates
    const parsedIssueDate = normalizeDate(issueDate);
    const parsedExpiryDate = normalizeDate(expiryDate);

    if (!parsedIssueDate || !parsedExpiryDate) {
        return res.status(400).json({
            message: "Invalid issue or expiry date provided.",
        });
    }

    try {
        // Get employeeId from employee record using optimized resolver
        const employee = await resolveEmployeeId(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found." });
        }

        const employeeId = employee.employeeId;

        // Fetch existing passport to handle renewal/archiving
        const existingPassport = await EmployeePassport.findOne({ employeeId });

        // HANDLE RENEWAL: Archive old passport to Documents tab
        if (isRenewal && existingPassport && existingPassport.document) {
            console.log(`[Passport Renewal] Archiving old passport for ${employeeId}`);

            const archiveDoc = {
                type: "Passport (Expired)",
                description: `Passport No: ${existingPassport.number || 'N/A'}, Expired on ${existingPassport.expiryDate ? new Date(existingPassport.expiryDate).toLocaleDateString() : 'N/A'}`,
                expiryDate: existingPassport.expiryDate,
                document: existingPassport.document
            };

            await EmployeeBasic.findOneAndUpdate(
                { employeeId },
                { $push: { documents: archiveDoc } }
            );
        }

        // Handle document upload to IDrive (S3) if new document provided
        let documentData = undefined;
        if (passportCopy) {
            // Check if it's already a URL (IDrive or otherwise)
            if (passportCopy.startsWith('http://') || passportCopy.startsWith('https://')) {
                // Already a URL
                documentData = {
                    url: passportCopy,
                    name: passportCopyName || "",
                    mimeType: passportCopyMime || "",
                };
            } else {
                // Upload base64 to IDrive
                // Note: s3Upload utility handles base64 prefixes automatically
                const uploadResult = await uploadDocumentToS3(
                    passportCopy,
                    `employee-documents/${employeeId}/passport`,
                    passportCopyName || 'passport.pdf',
                    'raw'
                );

                // Delete old document from IDrive ONLY if NOT renewing
                // If renewing, we kept the old doc in the archive, so don't delete it!
                if (!isRenewal && existingPassport?.document?.publicId) {
                    await deleteDocumentFromS3(existingPassport.document.publicId);
                }

                documentData = {
                    url: uploadResult.url,
                    publicId: uploadResult.publicId,
                    name: passportCopyName || "",
                    mimeType: passportCopyMime || "",
                };
            }
        } else {
            // Preserve existing document if no new one provided AND NOT RENEWAL
            // If renewal and no new doc provided, it effectively clears the doc (unless frontend forces a new one)
            if (!isRenewal && existingPassport?.document) {
                documentData = existingPassport.document;
            }
        }



        const passportPayload = {
            number: (typeof number === 'string' ? number.trim() : number) || "",
            nationality: (typeof nationality === 'string' ? nationality.trim() : nationality) || "",
            issueDate: parsedIssueDate,
            expiryDate: parsedExpiryDate,
            placeOfIssue: (typeof placeOfIssue === 'string' ? placeOfIssue.trim() : placeOfIssue) || "",
            document: documentData,
            lastUpdated: new Date(),
            passportExp: parsedExpiryDate, // Update expiry date for quick reference
        };

        // Update or create passport record
        const updatedPassport = await EmployeePassport.findOneAndUpdate(
            { employeeId },
            passportPayload,
            { upsert: true, new: true }
        );

        console.log("✅ Passport details saved for employee:", employeeId);
        console.log("   Passport Number:", passportPayload.number);
        console.log("   Expiry Date:", passportPayload.expiryDate);
        const completeEmployee = await getCompleteEmployee(employeeId);

        return res.json({
            message: "Passport details updated successfully.",
            passportDetails: {
                number: updatedPassport.number,
                nationality: updatedPassport.nationality,
                issueDate: updatedPassport.issueDate,
                expiryDate: updatedPassport.expiryDate,
                placeOfIssue: updatedPassport.placeOfIssue,
                document: updatedPassport.document,
                lastUpdated: updatedPassport.lastUpdated,
            },
            employee: completeEmployee
        });
    } catch (error) {
        console.error("Failed to update passport details:", error);
        return res.status(500).json({
            message: "Failed to update passport details.",
            error: error.message,
        });
    }
};

