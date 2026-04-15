import EmployeeEmergencyContact from "../../models/EmployeeEmergencyContact.js";
import { getCompleteEmployee, resolveEmployeeId } from "../../services/employeeService.js";
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";

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

        const updated = await EmployeeEmergencyContact.findOneAndUpdate(
            { employeeId },
            {
                $push: {
                    emergencyContacts: {
                        name,
                        relation,
                        number: normalizedNumber
                    }
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
        const completeEmployee = await getCompleteEmployee(employeeId);

        return res.status(200).json({
            message: "Emergency contact added",
            emergencyContacts: updated.emergencyContacts,
            employee: completeEmployee
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: err.message });
    }
};









