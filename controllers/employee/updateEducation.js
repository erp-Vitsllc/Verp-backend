import EmployeeEducation from "../../models/EmployeeEducation.js";
import { getCompleteEmployee, resolveEmployeeId } from "../../services/employeeService.js";

export const updateEducation = async (req, res) => {
    const { id, educationId } = req.params;
    const { universityOrBoard, collegeOrInstitute, course, fieldOfStudy, completedYear, certificate } = req.body;

    // Validate required fields and types
    if (!universityOrBoard || !collegeOrInstitute || !course || !fieldOfStudy || !completedYear) {
        return res.status(400).json({
            message: "University/Board, College/Institute, Course, Field of Study, and Completed Year are required"
        });
    }

    if (typeof universityOrBoard !== 'string' ||
        typeof collegeOrInstitute !== 'string' ||
        typeof course !== 'string' ||
        typeof fieldOfStudy !== 'string' ||
        typeof completedYear !== 'string') {
        return res.status(400).json({
            message: "All education fields must be valid strings"
        });
    }

    try {
        // Get employeeId from employee record using optimized resolver
        const employee = await resolveEmployeeId(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const employeeId = employee.employeeId;

        const educationRecord = await EmployeeEducation.findOne({ employeeId });

        if (!educationRecord) {
            return res.status(404).json({ message: "Education record not found" });
        }

        const education = educationRecord.educationDetails.id(educationId);

        if (!education) {
            return res.status(404).json({ message: "Education record not found" });
        }

        // Update education fields
        education.universityOrBoard = universityOrBoard.trim();
        education.collegeOrInstitute = collegeOrInstitute.trim();
        education.course = course.trim();
        education.fieldOfStudy = fieldOfStudy.trim();
        education.completedYear = completedYear.trim();

        // Update certificate if provided
        if (certificate && certificate.data) {
            education.certificate = {
                data: certificate.data,
                name: certificate.name || '',
                mimeType: certificate.mimeType || 'application/pdf'
            };
        } else if (certificate === null) {
            // Allow clearing the certificate
            education.certificate = undefined;
        }

        await educationRecord.save();
        const completeEmployee = await getCompleteEmployee(employeeId);

        return res.status(200).json({
            message: "Education details updated successfully",
            educationDetails: educationRecord.educationDetails,
            employee: completeEmployee
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: err.message });
    }
};













