import EmployeeVisa from "../../models/EmployeeVisa.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { resolveEmployeeId } from "../../services/employeeService.js";
import { deleteDocumentFromS3 } from "../../utils/s3Upload.js";
import { awaitAdminDeletionArchive } from "../../utils/adminDeletionArchiveRun.js";
import { denyEmployeeCardDeleteUnlessAllowed } from "../../utils/employeeCardDeleteAccess.js";
import { isActiveEmployeeProfile } from "../../utils/profileFileChangeHrNotify.js";
import { cleanupEmployeeExpiryNotificationsByLabels } from "../../utils/cleanupEmployeeExpiryNotifications.js";
import { PURGE_TYPES, purgeEmployeeOldDocuments } from "../../utils/purgeEmployeeOldDocuments.js";

const ALLOWED_VISA_TYPES = ["visit", "employment", "spouse"];

const visaLabelByType = {
    visit: "Visit Visa",
    employment: "Employment Visa",
    spouse: "Third Party",
};

export const deleteVisaDetails = async (req, res) => {
    const { id, type } = req.params;

    if (!type || !ALLOWED_VISA_TYPES.includes(type)) {
        return res.status(400).json({ message: "Invalid visa type provided." });
    }

    try {
        const employee = await resolveEmployeeId(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found." });
        }
        const employeeId = employee.employeeId;

        const employeeBasic = await EmployeeBasic.findOne({ employeeId })
            .select("profileStatus profileApprovalStatus")
            .lean();
        const denied = await denyEmployeeCardDeleteUnlessAllowed(req, employeeBasic, "visa details");
        if (denied) return res.status(denied.status).json(denied.body);

        const existingVisa = await EmployeeVisa.findOne({ employeeId }).lean();
        if (existingVisa?.[type]) {
            if (isActiveEmployeeProfile(employeeBasic)) {
                await awaitAdminDeletionArchive(req, {
                    moduleName: `Employee Visa (${type})`,
                    recordId: employeeId,
                    details: `Visa type ${type} for ${employeeId}`,
                    deletedPayload: { employeeId, visaType: type, visa: existingVisa[type] },
                });
            }
        }
        if (existingVisa?.[type]?.document?.publicId) {
            try {
                await deleteDocumentFromS3(existingVisa[type].document.publicId);
            } catch (s3Error) {
                console.error("Error deleting document from S3:", s3Error);
            }
        }

        const updatedVisa = await EmployeeVisa.findOneAndUpdate(
            { employeeId },
            {
                $unset: {
                    [type]: "",
                },
            },
            { new: true },
        );

        if (!updatedVisa) {
            return res.status(404).json({ message: "Visa record not found." });
        }

        await purgeEmployeeOldDocuments(employeeId, {
            types: PURGE_TYPES.visa(type),
            purgeDeletedArchiveReason: true,
        });

        await cleanupEmployeeExpiryNotificationsByLabels({
            employeeObjectId: employee._id,
            labels: [visaLabelByType[type] || "Visa"],
        });

        return res.json({
            message: `${visaLabelByType[type] || type} details deleted successfully.`,
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
