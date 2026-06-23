import EmployeeDrivingLicense from "../../models/EmployeeDrivingLicense.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { resolveEmployeeId } from "../../services/employeeService.js";
import { denyEmployeeCardDeleteUnlessAllowed } from "../../utils/employeeCardDeleteAccess.js";
import { disposeEmployeeProfileAttachment } from "../../utils/profileAttachmentDisposition.js";
import { cleanupEmployeeExpiryNotificationsByLabels } from "../../utils/cleanupEmployeeExpiryNotifications.js";
import { PURGE_TYPES, purgeEmployeeOldDocuments } from "../../utils/purgeEmployeeOldDocuments.js";
import { scheduleEmployeeProfileFileChangeHrEmailForRequest } from "../../utils/employeeInformativeHrNotify.js";
import { scheduleEmployeeCardDeletedNotification } from "../../utils/cardDeleteNotificationHelper.js";

export const deleteDrivingLicenseDetails = async (req, res) => {
    const { id } = req.params;
    try {
        const employee = await resolveEmployeeId(id);
        if (!employee) return res.status(404).json({ message: "Employee not found." });

        const employeeBasic = await EmployeeBasic.findOne({ employeeId: employee.employeeId })
            .select("profileStatus profileApprovalStatus")
            .lean();
        const denied = await denyEmployeeCardDeleteUnlessAllowed(req, employeeBasic, "Driving License details");
        if (denied) return res.status(denied.status).json(denied.body);

        const card = await EmployeeDrivingLicense.findOne({ employeeId: employee.employeeId }).lean();
        if (card?.drivingLicenceDetails?.document) {
            await disposeEmployeeProfileAttachment(req, {
                employeeBasic,
                attachment: card.drivingLicenceDetails.document,
                archive: {
                    moduleName: "Employee Driving License",
                    recordId: employee.employeeId,
                    details: `Driving license for ${employee.employeeId}`,
                    deletedPayload: { employeeId: employee.employeeId, drivingLicense: card },
                },
            });
        }

        await EmployeeDrivingLicense.deleteOne({ employeeId: employee.employeeId });
        await purgeEmployeeOldDocuments(employee.employeeId, {
            types: PURGE_TYPES.driving,
            purgeDeletedArchiveReason: true,
        });
        await cleanupEmployeeExpiryNotificationsByLabels({
            employeeObjectId: employee._id,
            labels: ["Driving License"],
        });

        scheduleEmployeeProfileFileChangeHrEmailForRequest({
            req,
            employeeId: employee.employeeId,
            employeeBasic,
            sectionKey: "drivingLicense",
            sectionLabel: "Driving License",
            action: "deleted",
            attachments: card?.drivingLicenceDetails?.document,
            actor: req.user,
        });

        scheduleEmployeeCardDeletedNotification(req, employee, {
            cardLabel: "Driving License",
            cardKey: "drivingLicense",
        });

        return res.status(200).json({ message: "Driving License details deleted successfully." });
    } catch (error) {
        console.error("Failed to delete Driving License details:", error);
        return res.status(500).json({ message: "Failed to delete Driving License details.", error: error.message });
    }
};
