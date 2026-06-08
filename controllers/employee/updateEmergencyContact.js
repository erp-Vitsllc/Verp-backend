import EmployeeEmergencyContact from "../../models/EmployeeEmergencyContact.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getCompleteEmployee, resolveEmployeeId } from "../../services/employeeService.js";
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";
import { shouldSkipLiveEmployeeSection, queueOrTriggerProfileChange } from "../../utils/pushPendingReactivationChange.js";
import { scheduleEmployeeProfileFileChangeHrEmailForRequest } from "../../utils/employeeInformativeHrNotify.js";

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
        const employeeBasic = await EmployeeBasic.findOne({ employeeId })
            .select("profileStatus profileWorkflow profileApprovalStatus company")
            .lean();
        const skipLive = shouldSkipLiveEmployeeSection(employeeBasic, "emergencyContact");
        const currentRecord = await EmployeeEmergencyContact.findOne({ employeeId });
        const currentContact = currentRecord?.emergencyContacts?.id(contactId);
        const proposedContact = {
            ...(currentContact?.toObject ? currentContact.toObject() : {}),
            name: trimmedName,
            relation,
            number: normalizedNumber,
        };

        const emergencyUpdateEntry = {
            card: "Emergency Contact",
            reason: "Emergency contact updated",
            section: "emergencyContact",
            changeType: "update",
            targetIndex: null,
            previousData: currentContact?.toObject ? currentContact.toObject() : currentContact,
            proposedData: { contactId, ...proposedContact },
        };

        let updated = null;
        if (skipLive) {
            await queueOrTriggerProfileChange({
                employeeId,
                actor: req.user,
                reason: "Emergency contact updated",
                employeeBasic,
                changeEntry: emergencyUpdateEntry,
            });
            updated = currentRecord;
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

            if (!updated) {
                return res.status(404).json({ message: "Employee or contact not found" });
            }

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

            await updated.save();
            await triggerProfileReactivationIfNeeded({
                employeeId,
                actor: req.user,
                reason: "Emergency contact updated",
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
            action: "edited",
            actor: req.user,
            skipLive,
        });

        return res.status(200).json({
            message: skipLive
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


