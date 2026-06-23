import EmployeeBasic from "../../models/EmployeeBasic.js";
import { resolveEmployeeId } from "../../services/employeeService.js";
import { denyEmployeeCardDeleteUnlessAllowed } from "../../utils/employeeCardDeleteAccess.js";
import { disposeEmployeeProfileAttachment } from "../../utils/profileAttachmentDisposition.js";
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";
import { scheduleEmployeeProfileFileChangeHrEmailForRequest } from "../../utils/employeeInformativeHrNotify.js";
import { scheduleEmployeeCardDeletedNotification } from "../../utils/cardDeleteNotificationHelper.js";

export const deleteWorkDetailsCard = async (req, res) => {
    const { id } = req.params;
    try {
        const employee = await resolveEmployeeId(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found." });
        }

        const workSnapshot = await EmployeeBasic.findOne({ employeeId: employee.employeeId })
            .select(
                "employeeId reportingAuthority primaryReportee secondaryReportee overtime department designation role company companyEmail contractJoiningDate dateOfJoining probationPeriod profileStatus profileApprovalStatus"
            )
            .lean();
        const denied = await denyEmployeeCardDeleteUnlessAllowed(req, workSnapshot, "work details", "workDetails");
        if (denied) return res.status(denied.status).json(denied.body);

        await disposeEmployeeProfileAttachment(req, {
            employeeBasic: workSnapshot,
            archive: {
                moduleName: "Employee Work Details",
                recordId: employee.employeeId,
                details: `Work details for ${employee.employeeId}`,
                deletedPayload: workSnapshot,
            },
        });

        await EmployeeBasic.updateOne(
            { employeeId: employee.employeeId },
            {
                $set: {
                    reportingAuthority: null,
                    primaryReportee: null,
                    secondaryReportee: null,
                    overtime: false,
                    department: "",
                    designation: "",
                    role: "",
                    company: null,
                    companyEmail: "",
                    contractJoiningDate: null,
                    dateOfJoining: null,
                    probationPeriod: null,
                },
            }
        );

        await triggerProfileReactivationIfNeeded({
            employeeId: employee.employeeId,
            actor: req.user,
            reason: "Work details card deleted",
        });

        scheduleEmployeeProfileFileChangeHrEmailForRequest({
            req,
            employeeId: employee.employeeId,
            employeeBasic: workSnapshot,
            sectionKey: "workDetails",
            sectionLabel: "Work Details",
            action: "deleted",
            actor: req.user,
        });

        scheduleEmployeeCardDeletedNotification(req, employee, {
            cardLabel: "Work Details",
            cardKey: "workDetails",
        });

        return res.status(200).json({ message: "Work details deleted successfully." });
    } catch (error) {
        console.error("Failed to delete work details:", error);
        return res.status(500).json({ message: "Failed to delete work details.", error: error.message });
    }
};
