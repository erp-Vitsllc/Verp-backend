import EmployeeMedicalInsurance from "../../models/EmployeeMedicalInsurance.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { resolveEmployeeId } from "../../services/employeeService.js";
import { denyEmployeeCardDeleteUnlessAllowed } from "../../utils/employeeCardDeleteAccess.js";
import { disposeEmployeeProfileAttachment } from "../../utils/profileAttachmentDisposition.js";
import { cleanupEmployeeExpiryNotificationsByLabels } from "../../utils/cleanupEmployeeExpiryNotifications.js";
import { PURGE_TYPES, purgeEmployeeOldDocuments } from "../../utils/purgeEmployeeOldDocuments.js";
import { scheduleEmployeeProfileFileChangeHrEmailForRequest } from "../../utils/employeeInformativeHrNotify.js";
import { scheduleEmployeeCardDeletedNotification } from "../../utils/cardDeleteNotificationHelper.js";

export const deleteMedicalInsuranceDetails = async (req, res) => {
    const { id } = req.params;
    try {
        const employee = await resolveEmployeeId(id);
        if (!employee) return res.status(404).json({ message: "Employee not found." });

        const employeeBasic = await EmployeeBasic.findOne({ employeeId: employee.employeeId })
            .select("profileStatus profileApprovalStatus")
            .lean();
        const denied = await denyEmployeeCardDeleteUnlessAllowed(req, employeeBasic, "Medical Insurance details");
        if (denied) return res.status(denied.status).json(denied.body);

        const card = await EmployeeMedicalInsurance.findOne({ employeeId: employee.employeeId }).lean();
        if (card?.medicalInsurance?.document) {
            await disposeEmployeeProfileAttachment(req, {
                employeeBasic,
                attachment: card.medicalInsurance.document,
                archive: {
                    moduleName: "Employee Medical Insurance",
                    recordId: employee.employeeId,
                    details: `Medical insurance for ${employee.employeeId}`,
                    deletedPayload: { employeeId: employee.employeeId, medicalInsurance: card },
                },
            });
        }

        await EmployeeMedicalInsurance.deleteOne({ employeeId: employee.employeeId });
        await purgeEmployeeOldDocuments(employee.employeeId, {
            types: PURGE_TYPES.medical,
            purgeDeletedArchiveReason: true,
        });
        await cleanupEmployeeExpiryNotificationsByLabels({
            employeeObjectId: employee._id,
            labels: ["Medical Insurance"],
        });

        scheduleEmployeeProfileFileChangeHrEmailForRequest({
            req,
            employeeId: employee.employeeId,
            employeeBasic,
            sectionKey: "medicalInsurance",
            sectionLabel: "Medical Insurance",
            action: "deleted",
            attachments: card?.medicalInsurance?.document,
            actor: req.user,
        });

        scheduleEmployeeCardDeletedNotification(req, employee, {
            cardLabel: "Medical Insurance",
            cardKey: "medicalInsurance",
        });

        return res.status(200).json({ message: "Medical Insurance details deleted successfully." });
    } catch (error) {
        console.error("Failed to delete Medical Insurance details:", error);
        return res.status(500).json({ message: "Failed to delete Medical Insurance details.", error: error.message });
    }
};
