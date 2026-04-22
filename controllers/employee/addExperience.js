import EmployeeExperience from "../../models/EmployeeExperience.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getCompleteEmployee, resolveEmployeeId } from "../../services/employeeService.js";
import { uploadDocumentToS3 } from "../../utils/s3Upload.js";
import { triggerProfileReactivationIfNeeded, shouldQueueProfileChange } from "../../utils/triggerProfileReactivation.js";

export const addExperience = async (req, res) => {
    const { id } = req.params;
    const { company, designation, startDate, endDate, certificate } = req.body;

    // Validate required fields and types
    if (typeof company !== 'string' || !company.trim() ||
        typeof designation !== 'string' || !designation.trim() ||
        !startDate) {
        return res.status(400).json({
            message: "Company and Designation must be valid strings, and Start Date is required"
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
        const employeeBasic = await EmployeeBasic.findOne({ employeeId }).select("profileStatus profileWorkflow").lean();
        const requiresApprovalQueue = shouldQueueProfileChange(employeeBasic);

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
        if (requiresApprovalQueue) {
            await triggerProfileReactivationIfNeeded({
                employeeId,
                actor: req.user,
                reason: "Experience details added",
                changeEntry: {
                    card: "Experience",
                    reason: "Experience details added",
                    section: "experience",
                    changeType: "add",
                    targetIndex: null,
                    previousData: null,
                    proposedData: experienceData,
                },
            });
        } else {
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

            await triggerProfileReactivationIfNeeded({
                employeeId,
                actor: req.user,
                reason: "Experience details added",
            });
        }
        const completeEmployee = await getCompleteEmployee(employeeId);

        return res.status(200).json({
            message: requiresApprovalQueue
                ? "Experience change queued for HR activation approval."
                : "Experience details added successfully",
            experienceDetails: updated?.experienceDetails || completeEmployee?.experienceDetails,
            employee: completeEmployee
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: err.message });
    }
};













