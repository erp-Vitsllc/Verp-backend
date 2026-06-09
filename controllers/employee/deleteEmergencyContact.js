import EmployeeEmergencyContact from "../../models/EmployeeEmergencyContact.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getCompleteEmployee } from "../../services/employeeService.js";
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";
import { shouldSkipLiveEmployeeSection, queueOrTriggerProfileChange } from "../../utils/pushPendingReactivationChange.js";
import { awaitAdminDeletionArchive } from "../../utils/adminDeletionArchiveRun.js";
import { denyEmployeeCardDeleteUnlessAllowed } from "../../utils/employeeCardDeleteAccess.js";
import { scheduleEmployeeProfileFileChangeHrEmailForRequest } from "../../utils/employeeInformativeHrNotify.js";

export const deleteEmergencyContact = async (req, res) => {
    const { id, contactId } = req.params;

    if (!contactId) {
        return res.status(400).json({ message: "Contact ID is required" });
    }

    try {
        const employee = await getCompleteEmployee(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const employeeId = employee.employeeId;
        const employeeBasic = await EmployeeBasic.findOne({ employeeId })
            .select("profileStatus profileWorkflow profileApprovalStatus company")
            .lean();
        const denied = await denyEmployeeCardDeleteUnlessAllowed(req, employeeBasic, "emergency contacts");
        if (denied) return res.status(denied.status).json(denied.body);

        const skipLive = shouldSkipLiveEmployeeSection(employeeBasic, "emergencyContact", req.user);

        const contactRecord = await EmployeeEmergencyContact.findOne({ employeeId });

        if (!contactRecord) {
            return res.status(404).json({ message: "Emergency contact record not found" });
        }

        const contact = contactRecord.emergencyContacts.id(contactId);

        if (!contact) {
            return res.status(404).json({ message: "Emergency contact not found" });
        }

        const emergencyDeleteEntry = {
            card: "Emergency Contact",
            reason: "Emergency contact deleted",
            section: "emergencyContact",
            changeType: "delete",
            targetIndex: null,
            previousData: contact?.toObject ? contact.toObject() : contact,
            proposedData: { contactId },
        };

        if (skipLive) {
            await queueOrTriggerProfileChange({
                employeeId,
                actor: req.user,
                reason: "Emergency contact deleted",
                employeeBasic,
                changeEntry: emergencyDeleteEntry,
            });
        } else {
            const contactSnapshot = contact.toObject ? contact.toObject() : { ...contact };
            await awaitAdminDeletionArchive(req, {
                moduleName: "Employee Emergency Contact",
                recordId: employeeId,
                details: contactSnapshot?.name || "Emergency contact",
                deletedPayload: { employeeId, contact: contactSnapshot },
            });
            contact.deleteOne();
            const primaryContact = contactRecord.emergencyContacts?.[0];
            if (primaryContact) {
                contactRecord.emergencyContactName = primaryContact.name || '';
                contactRecord.emergencyContactRelation = primaryContact.relation || 'Self';
                contactRecord.emergencyContactNumber = primaryContact.number || '';
            } else {
                contactRecord.emergencyContactName = '';
                contactRecord.emergencyContactRelation = '';
                contactRecord.emergencyContactNumber = '';
            }

            await contactRecord.save();
            await triggerProfileReactivationIfNeeded({
                employeeId,
                actor: req.user,
                reason: "Emergency contact deleted",
                changeEntry: null,
                trackDefaultChange: true,
            });
        }
        const completeEmployee = await getCompleteEmployee(employeeId);

        scheduleEmployeeProfileFileChangeHrEmailForRequest({
            employeeId,
            employeeBasic,
            sectionKey: "emergencyContact",
            sectionLabel: "Emergency Contact",
            action: "deleted",
            actor: req.user,
            skipLive,
        });

        return res.status(200).json({
            message: skipLive
                ? "Emergency contact deletion queued for HR activation approval."
                : "Emergency contact deleted",
            emergencyContacts: completeEmployee.emergencyContacts,
            employee: completeEmployee
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: err.message });
    }
};


















