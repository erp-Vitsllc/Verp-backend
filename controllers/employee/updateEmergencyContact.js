import EmployeeEmergencyContact from "../../models/EmployeeEmergencyContact.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getCompleteEmployee, resolveEmployeeId } from "../../services/employeeService.js";
import { triggerProfileReactivationIfNeeded, shouldQueueProfileChange } from "../../utils/triggerProfileReactivation.js";

export const updateEmergencyContact = async (req, res) => {
    const { id, contactId } = req.params;
    const { name, relation = 'Self', number } = req.body;

    if (!name || !number) {
        return res.status(400).json({ message: "Name and number are required" });
    }

    if (typeof name !== 'string' || (typeof number !== 'string' && typeof number !== 'number')) {
        return res.status(400).json({ message: "Name must be a string and number must be a string or number" });
    }

    const trimmedName = name.trim();
    const rawNumber = number.toString().trim();

    if (!trimmedName || !rawNumber) {
        return res.status(400).json({ message: "Name and number are required" });
    }

    const normalizedNumber = rawNumber.startsWith('+') ? rawNumber : `+${rawNumber}`;

    try {
        // Get employeeId from employee record using optimized resolver
        const employee = await resolveEmployeeId(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const employeeId = employee.employeeId;
        const employeeBasic = await EmployeeBasic.findOne({ employeeId }).select("profileStatus profileWorkflow").lean();
        const requiresApprovalQueue = shouldQueueProfileChange(employeeBasic);
        const currentRecord = await EmployeeEmergencyContact.findOne({ employeeId });
        const currentContact = currentRecord?.emergencyContacts?.id(contactId);
        const proposedContact = {
            ...(currentContact?.toObject ? currentContact.toObject() : {}),
            name: trimmedName,
            relation,
            number: normalizedNumber,
        };

        let updated = null;
        if (requiresApprovalQueue) {
            await triggerProfileReactivationIfNeeded({
                employeeId,
                actor: req.user,
                reason: "Emergency contact updated",
                changeEntry: {
                    card: "Emergency Contact",
                    reason: "Emergency contact updated",
                    section: "emergencyContact",
                    changeType: "update",
                    targetIndex: null,
                    previousData: currentContact?.toObject ? currentContact.toObject() : currentContact,
                    proposedData: { contactId, ...proposedContact },
                },
            });
        } else {
            updated = await EmployeeEmergencyContact.findOneAndUpdate(
                { employeeId, "emergencyContacts._id": contactId },
                {
                    $set: {
                        "emergencyContacts.$.name": trimmedName,
                        "emergencyContacts.$.relation": relation,
                        "emergencyContacts.$.number": normalizedNumber
                    }
                },
                { new: true, runValidators: true }
            );
        }

        if (!updated) {
            if (!requiresApprovalQueue) {
                return res.status(404).json({ message: "Employee or contact not found" });
            }
            updated = currentRecord;
        }

        // Update legacy fields from first contact
        const primaryContact = updated.emergencyContacts?.[0];
        if (primaryContact) {
            updated.emergencyContactName = primaryContact.name || '';
            updated.emergencyContactRelation = primaryContact.relation || 'Self';
            updated.emergencyContactNumber = primaryContact.number || '';
        } else {
            updated.emergencyContactName = '';
            updated.emergencyContactRelation = '';
            updated.emergencyContactNumber = '';
        }

        if (!requiresApprovalQueue) {
            await updated.save();
            await triggerProfileReactivationIfNeeded({
                employeeId,
                actor: req.user,
                reason: "Emergency contact updated",
            });
        }
        const completeEmployee = await getCompleteEmployee(employeeId);

        return res.status(200).json({
            message: requiresApprovalQueue
                ? "Emergency contact change queued for HR activation approval."
                : "Emergency contact updated",
            emergencyContacts: updated.emergencyContacts,
            employee: completeEmployee
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: err.message });
    }
};


