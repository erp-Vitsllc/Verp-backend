import EmployeeEmergencyContact from "../../models/EmployeeEmergencyContact.js";
import { getCompleteEmployee, resolveEmployeeId } from "../../services/employeeService.js";

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

        const updated = await EmployeeEmergencyContact.findOneAndUpdate(
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

        await updated.save();
        const completeEmployee = await getCompleteEmployee(employeeId);

        return res.status(200).json({
            message: "Emergency contact updated",
            emergencyContacts: updated.emergencyContacts,
            employee: completeEmployee
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: err.message });
    }
};


