import EmployeeExperience from "../../models/EmployeeExperience.js";
import { getCompleteEmployee, resolveEmployeeId } from "../../services/employeeService.js";
import { uploadDocumentToS3 } from "../../utils/s3Upload.js";

export const updateExperience = async (req, res) => {
    const { id, experienceId } = req.params;
    const { company, designation, startDate, endDate, certificate } = req.body;

    // Validate required fields and types
    if (!company || !designation || !startDate) {
        return res.status(400).json({
            message: "Company, Designation, and Start Date are required"
        });
    }

    if (typeof company !== 'string' || typeof designation !== 'string') {
        return res.status(400).json({
            message: "Company and Designation must be valid strings"
        });
    }

    // Validate that end date is after start date if both are provided
    if (endDate && new Date(endDate) < new Date(startDate)) {
        return res.status(400).json({
            message: "End Date must be after Start Date"
        });
    }

    try {
        // Get employeeId from employee record using optimized resolver
        const employee = await resolveEmployeeId(id);
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

        // Update experience fields
        experience.company = company.trim();
        experience.designation = designation.trim();
        experience.startDate = new Date(startDate);
        experience.endDate = endDate ? new Date(endDate) : null;

        // Update certificate if provided
        if (certificate && certificate.data) {
            const folderPath = `employee-documents/${employeeId}/experience`;
            const uploadResult = await uploadDocumentToS3(
                certificate.data,
                folderPath,
                certificate.name || 'experience-certificate'
            );
            experience.certificate = {
                name: certificate.name || '',
                mimeType: certificate.mimeType || 'application/pdf',
                url: uploadResult.url,
                publicId: uploadResult.publicId
            };
        } else if (certificate && certificate.url) {
            experience.certificate = {
                name: certificate.name || '',
                mimeType: certificate.mimeType || 'application/pdf',
                url: certificate.url,
                publicId: certificate.publicId
            };
        } else if (certificate === null) {
            // Allow clearing the certificate
            experience.certificate = undefined;
        }

        await experienceRecord.save();
        const completeEmployee = await getCompleteEmployee(employeeId);

        return res.status(200).json({
            message: "Experience details updated successfully",
            experienceDetails: experienceRecord.experienceDetails,
            employee: completeEmployee
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: err.message });
    }
};













