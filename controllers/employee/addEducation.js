import EmployeeEducation from "../../models/EmployeeEducation.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getCompleteEmployee, resolveEmployeeId } from "../../services/employeeService.js";
import { uploadDocumentToS3 } from "../../utils/s3Upload.js";
import { triggerProfileReactivationIfNeeded, shouldQueueProfileChange } from "../../utils/triggerProfileReactivation.js";

export const addEducation = async (req, res) => {
    const { id } = req.params;
    const { universityOrBoard, collegeOrInstitute, course, fieldOfStudy, completedYear, certificate } = req.body;

    // Required: course, fieldOfStudy, completedYear
    if (typeof course !== 'string' || !course.trim() ||
        typeof fieldOfStudy !== 'string' || !fieldOfStudy.trim() ||
        typeof completedYear !== 'string' || !completedYear.trim()) {
        return res.status(400).json({
            message: "Course, Field of Study, and Completed Year are required and must be strings"
        });
    }

    // Optional: universityOrBoard, collegeOrInstitute (must be string if provided)
    if (
        (universityOrBoard !== undefined && typeof universityOrBoard !== 'string') ||
        (collegeOrInstitute !== undefined && typeof collegeOrInstitute !== 'string')
    ) {
        return res.status(400).json({
            message: "University and College must be valid strings when provided"
        });
    }

    try {
        // Get employeeId from employee record using optimized resolver
        const employee = await resolveEmployeeId(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const employeeId = employee.employeeId;
        const employeeBasic = await EmployeeBasic.findOne({ employeeId }).select("profileStatus profileWorkflow").lean();
        const requiresApprovalQueue = shouldQueueProfileChange(employeeBasic);

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
        if (requiresApprovalQueue) {
            await triggerProfileReactivationIfNeeded({
                employeeId,
                actor: req.user,
                reason: "Education details added",
                changeEntry: {
                    card: "Education",
                    reason: "Education details added",
                    section: "education",
                    changeType: "add",
                    targetIndex: null,
                    previousData: null,
                    proposedData: educationData,
                },
            });
        } else {
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

            await triggerProfileReactivationIfNeeded({
                employeeId,
                actor: req.user,
                reason: "Education details added",
            });
        }
        const completeEmployee = await getCompleteEmployee(employeeId);

        return res.status(200).json({
            message: requiresApprovalQueue
                ? "Education change queued for HR activation approval."
                : "Education details added successfully",
            educationDetails: updated?.educationDetails || completeEmployee?.educationDetails,
            employee: completeEmployee
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: err.message });
    }
};













