import EmployeeVisa from "../../models/EmployeeVisa.js";
import { resolveEmployeeId } from "../../services/employeeService.js";
import { deleteDocumentFromS3 } from "../../utils/s3Upload.js";
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";

const ALLOWED_VISA_TYPES = ["visit", "employment", "spouse"];

export const deleteVisaDetails = async (req, res) => {
    const { id, type } = req.params;

    if (!type || !ALLOWED_VISA_TYPES.includes(type)) {
        return res.status(400).json({ message: "Invalid visa type provided." });
    }

    try {
        const isAdmin = await isReqUserAdmin(req.user);
        if (!isAdmin) {
            return res.status(403).json({ message: "Only administrator can delete visa details." });
        }

        const employee = await resolveEmployeeId(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found." });
        }
        const employeeId = employee.employeeId;

        // Find existing record to delete document from S3 if exists
        const existingVisa = await EmployeeVisa.findOne({ employeeId });
        if (existingVisa?.[type]?.document?.publicId) {
            try {
                await deleteDocumentFromS3(existingVisa[type].document.publicId);
            } catch (s3Error) {
                console.error("Error deleting document from S3:", s3Error);
                // Continue with DB deletion even if S3 fails
            }
        }

        // Unset the specific visa type field
        const updatedVisa = await EmployeeVisa.findOneAndUpdate(
            { employeeId },
            {
                $unset: {
                    [type]: ""
                }
            },
            { new: true }
        );

        if (!updatedVisa) {
            return res.status(404).json({ message: "Visa record not found." });
        }

        await triggerProfileReactivationIfNeeded({
            employeeId,
            actor: req.user,
            reason: `${type} visa details deleted`,
        });
        return res.json({
            message: `${type} visa details deleted successfully.`,
            visaDetails: {
                visit: updatedVisa.visit,
                employment: updatedVisa.employment,
                spouse: updatedVisa.spouse,
            },
        });
    } catch (error) {
        console.error("Failed to delete visa details:", error);
        return res.status(500).json({
            message: "Failed to delete visa details.",
            error: error.message,
        });
    }
};
