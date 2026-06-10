import EmployeeExperience from "../../models/EmployeeExperience.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getCompleteEmployee, resolveEmployeeId } from "../../services/employeeService.js";
import { uploadDocumentToS3 } from "../../utils/s3Upload.js";
import { scheduleEmployeeProfileFileChangeHrEmailForRequest } from "../../utils/employeeInformativeHrNotify.js";
import { validateEmployeeExperiencePayload } from "../../utils/employeeExperienceValidation.js";


export const addExperience = async (req, res) => {
    const { id } = req.params;
    const { company, designation, startDate, endDate, certificate } = req.body;

    const validation = validateEmployeeExperiencePayload(req.body, { requireCertificate: true });
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
                const folderPath = `employee-documents/${employeeId}/experience`;
                const uploadResult = await uploadDocumentToS3(
                    certificate.data,
                    folderPath,
                    certificate.name || 'experience-certificate'
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

        const experienceData = {
            company: company.trim(),
            designation: designation.trim(),
            startDate: new Date(startDate),
            endDate: endDate ? new Date(endDate) : null,
            certificate: certificateData
        };

        let updated = null;
            // Update or create experience record
            updated = await EmployeeExperience.findOneAndUpdate(
                { employeeId },
                {
                    $push: {
                        experienceDetails: experienceData
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
            sectionKey: "experience",
            sectionLabel: "Experience",
            action: "added",
            attachments: certificateData,
            actor: req.user,
        });

        return res.status(200).json({
            message: "Experience details added successfully",
            experienceDetails: updated?.experienceDetails || completeEmployee?.experienceDetails,
            employee: completeEmployee
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: err.message });
    }
};













