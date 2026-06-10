import EmployeeEducation from "../../models/EmployeeEducation.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getCompleteEmployee, resolveEmployeeId } from "../../services/employeeService.js";
import { uploadDocumentToS3 } from "../../utils/s3Upload.js";
import { scheduleEmployeeProfileFileChangeHrEmailForRequest } from "../../utils/employeeInformativeHrNotify.js";
import { validateEmployeeEducationPayload } from "../../utils/employeeEducationValidation.js";


export const addEducation = async (req, res) => {
    const { id } = req.params;
    const { universityOrBoard, collegeOrInstitute, course, fieldOfStudy, completedYear, certificate } = req.body;

    const validation = validateEmployeeEducationPayload(req.body, { requireCertificate: true });
    if (!validation.ok) {
        return res.status(400).json({ message: validation.message });
    }

    try {
        // Get employeeId from employee record using optimized resolver
        const employee = await resolveEmployeeId(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const employeeId = employee.employeeId;


        let certificateData;
        if (certificate) {
            if (certificate.data && typeof certificate.data === 'string') {
                const folderPath = `employee-documents/${employeeId}/education`;
                const uploadResult = await uploadDocumentToS3(
                    certificate.data,
                    folderPath,
                    certificate.name || 'education-certificate'
                );
                certificateData = {
                    name: certificate.name || '',
                    mimeType: certificate.mimeType || 'application/pdf',
                    url: uploadResult.url,
                    publicId: uploadResult.publicId
                };
            } else if (certificate.url) {
                certificateData = {
                    name: certificate.name || '',
                    mimeType: certificate.mimeType || 'application/pdf',
                    url: certificate.url,
                    publicId: certificate.publicId
                };
            }
        }

        const educationData = {
            universityOrBoard: (universityOrBoard || '').trim(),
            collegeOrInstitute: (collegeOrInstitute || '').trim(),
            course: course.trim(),
            fieldOfStudy: fieldOfStudy.trim(),
            completedYear: completedYear.trim(),
            certificate: certificateData
        };

        let updated = null;
            // Update or create education record
            updated = await EmployeeEducation.findOneAndUpdate(
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

        scheduleEmployeeProfileFileChangeHrEmailForRequest({
            req,
            employeeId,
            sectionKey: "education",
            sectionLabel: "Education",
            action: "added",
            attachments: certificateData,
            actor: req.user,
        });

        return res.status(200).json({
            message: "Education details added successfully",
            educationDetails: updated?.educationDetails || completeEmployee?.educationDetails,
            employee: completeEmployee
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: err.message });
    }
};













