import EmployeeEducation from "../../models/EmployeeEducation.js";
import { getCompleteEmployee, resolveEmployeeId } from "../../services/employeeService.js";

export const addEducation = async (req, res) => {
    const { id } = req.params;
    const { universityOrBoard, collegeOrInstitute, course, fieldOfStudy, completedYear, certificate } = req.body;

    // Validate required fields and types
    if (typeof universityOrBoard !== 'string' || !universityOrBoard.trim() ||
        typeof collegeOrInstitute !== 'string' || !collegeOrInstitute.trim() ||
        typeof course !== 'string' || !course.trim() ||
        typeof fieldOfStudy !== 'string' || !fieldOfStudy.trim() ||
        typeof completedYear !== 'string' || !completedYear.trim()) {
        return res.status(400).json({
            message: "University, College, Course, Field of Study, and Completed Year are required and must be strings"
        });
    }

    try {
        // Get employeeId from employee record using optimized resolver
        const employee = await resolveEmployeeId(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const employeeId = employee.employeeId;

        const educationData = {
            universityOrBoard: universityOrBoard.trim(),
            collegeOrInstitute: collegeOrInstitute.trim(),
            course: course.trim(),
            fieldOfStudy: fieldOfStudy.trim(),
            completedYear: completedYear.trim(),
            certificate: certificate && certificate.data ? {
                data: certificate.data,
                name: certificate.name || '',
                mimeType: certificate.mimeType || 'application/pdf'
            } : undefined
        };

        // Update or create education record
        const updated = await EmployeeEducation.findOneAndUpdate(
            { employeeId },
            {
                $push: {
                    educationDetails: educationData
                }
            },
            { upsert: true, new: true, runValidators: true }
        );

        if (!updated) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const completeEmployee = await getCompleteEmployee(employeeId);

        return res.status(200).json({
            message: "Education details added successfully",
            educationDetails: updated.educationDetails,
            employee: completeEmployee
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: err.message });
    }
};













