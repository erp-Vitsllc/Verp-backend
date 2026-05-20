import EmployeeEmergencyContact from "../../models/EmployeeEmergencyContact.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getCompleteEmployee } from "../../services/employeeService.js";
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";
import { skipLiveProfileWritesPendingHr, queueOrTriggerProfileChange } from "../../utils/pushPendingReactivationChange.js";
import {
    isReqUserAdmin,
    scheduleManagementAdminDeletionEmail,
} from "../../utils/sendAdminDeletionNotificationEmails.js";

export const deleteEmergencyContact = async (req, res) => {
    const { id, contactId } = req.params;

    if (!contactId) {
        return res.status(400).json({ message: "Contact ID is required" });
    }

    try {
        const isAdmin = await isReqUserAdmin(req.user);
        if (!isAdmin) {
            return res.status(403).json({ message: "Only administrator can delete emergency contacts." });
        }
        // Get employeeId from employee record
        const employee = await getCompleteEmployee(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const employeeId = employee.employeeId;
        const employeeBasic = await EmployeeBasic.findOne({ employeeId })
            .select("profileStatus profileWorkflow profileApprovalStatus company")
            .lean();
        const skipLive = skipLiveProfileWritesPendingHr(employeeBasic);

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
            scheduleManagementAdminDeletionEmail(req, {
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


















