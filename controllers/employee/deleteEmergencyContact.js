import EmployeeEmergencyContact from "../../models/EmployeeEmergencyContact.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getCompleteEmployee } from "../../services/employeeService.js";
import { triggerProfileReactivationIfNeeded, shouldQueueProfileChange } from "../../utils/triggerProfileReactivation.js";

export const deleteEmergencyContact = async (req, res) => {
    const { id, contactId } = req.params;

    if (!contactId) {
        return res.status(400).json({ message: "Contact ID is required" });
    }

    try {
        // Get employeeId from employee record
        const employee = await getCompleteEmployee(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const employeeId = employee.employeeId;
        const employeeBasic = await EmployeeBasic.findOne({ employeeId }).select("profileStatus profileWorkflow").lean();
        const requiresApprovalQueue = shouldQueueProfileChange(employeeBasic);

        const contactRecord = await EmployeeEmergencyContact.findOne({ employeeId });

        if (!contactRecord) {
            return res.status(404).json({ message: "Emergency contact record not found" });
        }

        const contact = contactRecord.emergencyContacts.id(contactId);

        if (!contact) {
            return res.status(404).json({ message: "Emergency contact not found" });
        }

        if (requiresApprovalQueue) {
            await triggerProfileReactivationIfNeeded({
                employeeId,
                actor: req.user,
                reason: "Emergency contact deleted",
                changeEntry: {
                    card: "Emergency Contact",
                    reason: "Emergency contact deleted",
                    section: "emergencyContact",
                    changeType: "delete",
                    targetIndex: null,
                    previousData: contact?.toObject ? contact.toObject() : contact,
                    proposedData: { contactId },
                },
            });
        } else {
            contact.deleteOne();
        }

        // Update legacy fields from first contact
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

        if (!requiresApprovalQueue) {
            await contactRecord.save();
            await triggerProfileReactivationIfNeeded({
                employeeId,
                actor: req.user,
                reason: "Emergency contact deleted",
            });
        }
        const completeEmployee = await getCompleteEmployee(employeeId);

        return res.status(200).json({
            message: requiresApprovalQueue
                ? "Emergency contact deletion queued for HR activation approval."
                : "Emergency contact deleted",
            emergencyContacts: contactRecord.emergencyContacts,
            employee: completeEmployee
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: err.message });
    }
};


















