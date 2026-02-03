import EmployeeEmergencyContact from "../../models/EmployeeEmergencyContact.js";
import { getCompleteEmployee } from "../../services/employeeService.js";

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

        const contactRecord = await EmployeeEmergencyContact.findOne({ employeeId });

        if (!contactRecord) {
            return res.status(404).json({ message: "Emergency contact record not found" });
        }

        const contact = contactRecord.emergencyContacts.id(contactId);

        if (!contact) {
            return res.status(404).json({ message: "Emergency contact not found" });
        }

        contact.deleteOne();

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

        await contactRecord.save();
        const completeEmployee = await getCompleteEmployee(employeeId);

        return res.status(200).json({
            message: "Emergency contact deleted",
            emergencyContacts: contactRecord.emergencyContacts,
            employee: completeEmployee
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: err.message });
    }
};


















