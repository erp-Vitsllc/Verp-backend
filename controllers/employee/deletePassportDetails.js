import EmployeePassport from "../../models/EmployeePassport.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { resolveEmployeeId } from "../../services/employeeService.js";
import { denyEmployeeCardDeleteUnlessAllowed } from "../../utils/employeeCardDeleteAccess.js";
import { disposeEmployeeProfileAttachment } from "../../utils/profileAttachmentDisposition.js";
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";
import { cleanupEmployeeExpiryNotificationsByLabels } from "../../utils/cleanupEmployeeExpiryNotifications.js";
import { PURGE_TYPES, purgeEmployeeOldDocuments } from "../../utils/purgeEmployeeOldDocuments.js";
import { scheduleEmployeeProfileFileChangeHrEmailForRequest } from "../../utils/employeeInformativeHrNotify.js";
import { scheduleEmployeeCardDeletedNotification } from "../../utils/cardDeleteNotificationHelper.js";

export const deletePassportDetails = async (req, res) => {
    const { id } = req.params;
    try {
        const employee = await resolveEmployeeId(id);
        if (!employee) return res.status(404).json({ message: "Employee not found." });

        const employeeBasic = await EmployeeBasic.findOne({ employeeId: employee.employeeId })
            .select("profileStatus profileApprovalStatus")
            .lean();
        const denied = await denyEmployeeCardDeleteUnlessAllowed(req, employeeBasic, "passport details");
        if (denied) return res.status(denied.status).json(denied.body);

        const passport = await EmployeePassport.findOne({ employeeId: employee.employeeId }).lean();

        if (passport?.document) {
            await disposeEmployeeProfileAttachment(req, {
                employeeBasic,
                attachment: passport.document,
                archive: {
                    moduleName: "Employee Passport",
                    recordId: employee.employeeId,
                    details: `Passport card for ${employee.employeeId}`,
                    deletedPayload: { employeeId: employee.employeeId, passport },
                },
            });
        }

        await EmployeePassport.deleteOne({ employeeId: employee.employeeId });
        await purgeEmployeeOldDocuments(employee.employeeId, {
            types: PURGE_TYPES.passport,
            purgeDeletedArchiveReason: true,
        });
        await cleanupEmployeeExpiryNotificationsByLabels({
            employeeObjectId: employee._id,
            labels: ["Passport"],
        });
        await triggerProfileReactivationIfNeeded({
            employeeId: employee.employeeId,
            actor: req.user,
            reason: "Passport details deleted",
        });

        scheduleEmployeeProfileFileChangeHrEmailForRequest({
            req,
            employeeId: employee.employeeId,
            employeeBasic,
            sectionKey: "passport",
            sectionLabel: "Passport",
            action: "deleted",
            attachments: passport?.document,
            actor: req.user,
        });

        scheduleEmployeeCardDeletedNotification(req, employee, {
            cardLabel: "Passport",
            cardKey: "passport",
        });

        return res.status(200).json({ message: "Passport details deleted successfully." });
    } catch (error) {
        console.error("Failed to delete passport details:", error);
        return res.status(500).json({ message: "Failed to delete passport details.", error: error.message });
    }
};
