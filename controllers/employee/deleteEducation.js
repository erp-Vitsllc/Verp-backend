import EmployeeEducation from "../../models/EmployeeEducation.js";
import { getCompleteEmployee } from "../../services/employeeService.js";

import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { disposeEmployeeProfileAttachment } from "../../utils/profileAttachmentDisposition.js";
import { scheduleEmployeeProfileFileChangeHrEmailForRequest } from "../../utils/employeeInformativeHrNotify.js";

export const deleteEducation = async (req, res) => {
    const { id, educationId } = req.params;

    if (!educationId) {
        return res.status(400).json({ message: "Education ID is required" });
    }

    try {
        const isAdmin = await isReqUserAdmin(req.user);
        if (!isAdmin) {
            return res.status(403).json({ message: "Only administrator can delete education records." });
        }

        // Get employeeId from employee record
        const employee = await getCompleteEmployee(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const employeeId = employee.employeeId;

        const educationRecord = await EmployeeEducation.findOne({ employeeId });

        if (!educationRecord) {
            return res.status(404).json({ message: "Education record not found" });
        }

        const education = educationRecord.educationDetails.id(educationId);

        if (!education) {
            return res.status(404).json({ message: "Education record not found" });
        }

        const educationSnapshot = education.toObject ? education.toObject() : { ...education };
        const employeeBasic = await EmployeeBasic.findOne({ employeeId })
            .select("profileStatus profileApprovalStatus")
            .lean();
        await disposeEmployeeProfileAttachment(req, {
            employeeBasic,
            attachment: educationSnapshot?.certificate || educationSnapshot?.document,
            archive: {
                moduleName: "Employee Education",
                recordId: employeeId,
                details: educationSnapshot?.qualification || educationSnapshot?.institution || "Education record",
                deletedPayload: { employeeId, education: educationSnapshot },
            },
        });
        education.deleteOne();
        await educationRecord.save();
        const completeEmployee = await getCompleteEmployee(employeeId);

        scheduleEmployeeProfileFileChangeHrEmailForRequest({
            req,
            employeeId,
            sectionKey: "education",
            sectionLabel: "Education",
            action: "deleted",
            attachments: educationSnapshot?.certificate,
            actor: req.user,
        });

        return res.status(200).json({
            message: "Education record deleted successfully",
            educationDetails: educationRecord.educationDetails,
            employee: completeEmployee
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: err.message });
    }
};













