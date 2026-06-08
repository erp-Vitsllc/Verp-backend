import EmployeeExperience from "../../models/EmployeeExperience.js";
import { getCompleteEmployee } from "../../services/employeeService.js";

import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";
import { awaitAdminDeletionArchive } from "../../utils/adminDeletionArchiveRun.js";
import { scheduleEmployeeProfileFileChangeHrEmailForRequest } from "../../utils/employeeInformativeHrNotify.js";

export const deleteExperience = async (req, res) => {
    const { id, experienceId } = req.params;

    if (!experienceId) {
        return res.status(400).json({ message: "Experience ID is required" });
    }

    try {
        const isAdmin = await isReqUserAdmin(req.user);
        if (!isAdmin) {
            return res.status(403).json({ message: "Only administrator can delete experience records." });
        }

        // Get employeeId from employee record
        const employee = await getCompleteEmployee(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const employeeId = employee.employeeId;

        const experienceRecord = await EmployeeExperience.findOne({ employeeId });

        if (!experienceRecord) {
            return res.status(404).json({ message: "Experience record not found" });
        }

        const experience = experienceRecord.experienceDetails.id(experienceId);

        if (!experience) {
            return res.status(404).json({ message: "Experience record not found" });
        }

        const experienceSnapshot = experience.toObject ? experience.toObject() : { ...experience };
        await awaitAdminDeletionArchive(req, {
            moduleName: "Employee Experience",
            recordId: employeeId,
            details: experienceSnapshot?.companyName || experienceSnapshot?.designation || "Experience record",
            deletedPayload: { employeeId, experience: experienceSnapshot },
        });
        experience.deleteOne();
        await experienceRecord.save();
        const completeEmployee = await getCompleteEmployee(employeeId);

        scheduleEmployeeProfileFileChangeHrEmailForRequest({
            employeeId,
            sectionKey: "experience",
            sectionLabel: "Experience",
            action: "deleted",
            attachments: experienceSnapshot?.certificate,
            actor: req.user,
        });

        return res.status(200).json({
            message: "Experience record deleted successfully",
            experienceDetails: experienceRecord.experienceDetails,
            employee: completeEmployee
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: err.message });
    }
};













