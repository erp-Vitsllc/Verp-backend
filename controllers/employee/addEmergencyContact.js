import EmployeeEmergencyContact from "../../models/EmployeeEmergencyContact.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getCompleteEmployee, resolveEmployeeId } from "../../services/employeeService.js";
import { triggerProfileReactivationIfNeeded, shouldQueueProfileChange } from "../../utils/triggerProfileReactivation.js";

export const addEmergencyContact = async (req, res) => {
    const { id } = req.params;
    const { name, relation = 'Self', number } = req.body;

    if (!name || !number) {
        return res.status(400).json({ message: "Name and number are required" });
    }

    const normalizedNumber = number.startsWith('+') ? number : `+${number}`;

    try {
        // Get employeeId from employee record using optimized resolver
        const employee = await resolveEmployeeId(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const employeeId = employee.employeeId;
        const employeeBasic = await EmployeeBasic.findOne({ employeeId }).select("profileStatus profileWorkflow").lean();
        const requiresApprovalQueue = shouldQueueProfileChange(employeeBasic);

        const newContact = {
            name,
            relation,
            number: normalizedNumber
        };
        let updated = null;
        if (requiresApprovalQueue) {
            await triggerProfileReactivationIfNeeded({
                employeeId,
                actor: req.user,
                reason: "Emergency contact added",
                changeEntry: {
                    card: "Emergency Contact",
                    reason: "Emergency contact added",
                    section: "emergencyContact",
                    changeType: "add",
                    targetIndex: null,
                    previousData: null,
                    proposedData: newContact,
                },
            });
        } else {
            updated = await EmployeeEmergencyContact.findOneAndUpdate(
                { employeeId },
                {
                    $push: {
                        emergencyContacts: newContact
                    },
                    $setOnInsert: {
                        emergencyContactName: name,
                        emergencyContactRelation: relation,
                        emergencyContactNumber: normalizedNumber
                    }
                },
                { upsert: true, new: true, runValidators: true }
            );

            if (!updated) {
                return res.status(404).json({ message: "Employee not found" });
            }

            await triggerProfileReactivationIfNeeded({
                employeeId,
                actor: req.user,
                reason: "Emergency contact added",
            });
        }
        const completeEmployee = await getCompleteEmployee(employeeId);

        return res.status(200).json({
            message: requiresApprovalQueue
                ? "Emergency contact change queued for HR activation approval."
                : "Emergency contact added",
            emergencyContacts: updated?.emergencyContacts || completeEmployee?.emergencyContacts,
            employee: completeEmployee
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: err.message });
    }
};









