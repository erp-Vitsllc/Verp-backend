import EmployeeEducation from "../../models/EmployeeEducation.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getCompleteEmployee, resolveEmployeeId } from "../../services/employeeService.js";
import { uploadDocumentToS3 } from "../../utils/s3Upload.js";
import { scheduleEmployeeProfileFileChangeHrEmailForRequest } from "../../utils/employeeInformativeHrNotify.js";
import { validateEmployeeEducationPayload } from "../../utils/employeeEducationValidation.js";


export const updateEducation = async (req, res) => {
    const { id, educationId } = req.params;
    const { universityOrBoard, collegeOrInstitute, course, fieldOfStudy, completedYear, certificate } = req.body;

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

        const hasExistingCertificate = Boolean(education?.certificate?.url || education?.certificate?.name);
        const validation = validateEmployeeEducationPayload(req.body, {
            requireCertificate: false,
            hasExistingCertificate,
        });
        if (!validation.ok) {
            return res.status(400).json({ message: validation.message });
        }

        const previousEducation = education?.toObject ? education.toObject() : education;
        const proposedEducation = {
            ...previousEducation,
            universityOrBoard: (universityOrBoard || '').trim(),
            collegeOrInstitute: (collegeOrInstitute || '').trim(),
            course: course.trim(),
            fieldOfStudy: fieldOfStudy.trim(),
            completedYear: completedYear.trim(),
        };

        // Update certificate if provided
        if (certificate && certificate.data) {
            const folderPath = `employee-documents/${employeeId}/education`;
            const uploadResult = await uploadDocumentToS3(
                certificate.data,
                folderPath,
                certificate.name || 'education-certificate'
            );
            proposedEducation.certificate = {
                name: certificate.name || '',
                mimeType: certificate.mimeType || 'application/pdf',
                url: uploadResult.url,
                publicId: uploadResult.publicId
            };
        } else if (certificate && certificate.url) {
            proposedEducation.certificate = {
                name: certificate.name || '',
                mimeType: certificate.mimeType || 'application/pdf',
                url: certificate.url,
                publicId: certificate.publicId
            };
        } else if (certificate === null) {
            // Allow clearing the certificate
            proposedEducation.certificate = undefined;
        }
            // Update education fields
            education.universityOrBoard = proposedEducation.universityOrBoard;
            education.collegeOrInstitute = proposedEducation.collegeOrInstitute;
            education.course = proposedEducation.course;
            education.fieldOfStudy = proposedEducation.fieldOfStudy;
            education.completedYear = proposedEducation.completedYear;
            if (Object.prototype.hasOwnProperty.call(proposedEducation, "certificate")) {
                education.certificate = proposedEducation.certificate;
            }
            await educationRecord.save();
        
        const completeEmployee = await getCompleteEmployee(employeeId);

        scheduleEmployeeProfileFileChangeHrEmailForRequest({
            employeeId,
            sectionKey: "education",
            sectionLabel: "Education",
            action: "edited",
            attachments: proposedEducation.certificate,
            actor: req.user,
        });

        return res.status(200).json({
            message: "Education details updated successfully",
            educationDetails: educationRecord?.educationDetails || completeEmployee?.educationDetails,
            employee: completeEmployee
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: err.message });
    }
};













