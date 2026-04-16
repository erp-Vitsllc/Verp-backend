import Company from "../../models/Company.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import User from "../../models/User.js";
import DashboardAction from "../../models/DashboardAction.js";
import { sendResponsibilityApprovalEmail } from "../../utils/sendResponsibilityApprovalEmail.js";
import { buildResponsibilityEmailData } from "../../utils/flowchartResponsibilityEmailData.js";
import { getSignedFileUrl } from "../../utils/s3Upload.js";
import { calculateCompanyActivationProgress, shouldTriggerCompanyReactivation } from "../../utils/companyActivation.js";

export const updateCompany = async (req, res) => {
    try {
        const { id } = req.params;

        // Find by _id or companyId
        let company = await Company.findOne({
            $or: [{ _id: id.match(/^[0-9a-fA-F]{24}$/) ? id : null }, { companyId: id }]
        });

        if (!company) {
            return res.status(404).json({ message: "Company not found" });
        }

        // Update fields provided in req.body
        const updateData = req.body;
        const beforeCompany = company.toObject();

        if (updateData.responsibilities && Array.isArray(updateData.responsibilities)) {
            const existingResps = company.responsibilities || [];

            const isGlobal = updateData.isGlobalFlowUpdate === true;
            const categoriesToHandle = ['hr', 'accounts', 'assetcontroller', 'management', 'admincontroller'];

            for (const cat of categoriesToHandle) {
                const existingActive = existingResps.find(r => r.category === cat && r.status === 'Active');
                const newAssignee = updateData.responsibilities.find(r => r.category === cat && (!r.status || r.status === 'Pending' || r.status === 'Active'));

                if (newAssignee && (!existingActive || existingActive.employeeId !== newAssignee.employeeId)) {
                    // Force status to Pending for new assignments to ensure employee approval flow
                    newAssignee.status = 'Pending';

                    // If there was an existing one, we KEEP it as Active for continuity until approval
                    if (existingActive && existingActive.employeeId !== newAssignee.employeeId) {
                        const isOldInNew = updateData.responsibilities.some(r => r.employeeId === existingActive.employeeId && r.category === cat && r.status === 'Active');
                        if (!isOldInNew) {
                            const oldObj = existingActive.toObject ? existingActive.toObject() : existingActive;
                            updateData.responsibilities.push({
                                ...oldObj,
                                status: 'Active'
                            });
                        }
                    }
                }
            }

            for (const resp of updateData.responsibilities) {
                if (!resp.employeeId) continue;

                // Check employee exists and has company email
                const employee = await EmployeeBasic.findOne({
                    employeeId: { $regex: new RegExp(`^${resp.employeeId}$`, 'i') }
                });
                if (!employee) {
                    return res.status(400).json({ message: `Employee ${resp.employeeId} not found` });
                }

                resp.empObjectId = employee._id;

                if (!employee.companyEmail) {
                    return res.status(400).json({
                        message: `Employee ${employee.firstName} ${employee.lastName} (${resp.employeeId}) cannot be assigned a responsibility because they do not have a company email address.`
                    });
                }

                // Check if employee is also a user
                const linkedUser = await User.findOne({ employeeId: resp.employeeId });
                if (!linkedUser) {
                    return res.status(400).json({
                        message: `Employee ${employee.firstName} ${employee.lastName} (${resp.employeeId}) cannot be assigned a responsibility because they are not registered as a system user.`
                    });
                }

                // Trigger notifications for ANY pending responsibility
                if (resp.status === 'Pending') {
                    // Check if we already have a pending dashboard action for this specific role and employee
                    const existingAction = await DashboardAction.findOne({
                        assignedTo: employee._id,
                        requestType: 'Responsibility Approval',
                        status: 'Pending',
                        extra1: resp.category
                    });

                    if (!existingAction) {
                        try {
                            const newAction = await DashboardAction.create({
                                assignedTo: employee._id,
                                assignedToEmpId: employee.employeeId,
                                requestId: company._id,
                                requestType: 'Responsibility Approval',
                                subjectEmployeeId: employee.employeeId,
                                subjectName: `${employee.firstName} ${employee.lastName}`,
                                requestedByName: req.user.name || 'Admin',
                                extra1: resp.category,
                                extra2: isGlobal ? 'All Companies' : company.name,
                                status: 'Pending',
                                isGlobal: isGlobal
                            });

                            // Role label for email
                            const roleLabels = {
                                'hr': 'HR Admin',
                                'accounts': 'Financial Controller',
                                'assetcontroller': 'Asset Controller',
                                'management': 'General Management',
                                'admincontroller': 'System Admin'
                            };

                            const emailPayload =
                                resp.category === 'assetcontroller'
                                    ? await buildResponsibilityEmailData('assetcontroller')
                                    : null;

                            await sendResponsibilityApprovalEmail({
                                employee: employee,
                                companyName: isGlobal ? 'All Companies' : company.name,
                                category: roleLabels[resp.category] || resp.category,
                                requestId: newAction._id,
                                dashboardDeepLinkId: company._id,
                                unassignedAssets: [],
                                emailData: emailPayload ? { categoryKey: resp.category, ...emailPayload } : null
                            });
                        } catch (err) {
                            console.error(`Error creating responsibility approval action/email for ${resp.category}:`, err);
                        }
                    }
                }
            }
        }

        const updatedCompany = await Company.findByIdAndUpdate(
            company._id,
            { $set: updateData },
            { new: true, runValidators: true }
        );

        if (shouldTriggerCompanyReactivation(beforeCompany, updateData)) {
            // Any critical change after activation must move the company back to inactive,
            // but should not auto-submit to HR. Submission is manual from the UI button.
            updatedCompany.status = "Inactive";
            updatedCompany.activationStatus = "draft";
            updatedCompany.activationSubmittedTo = null;
            await updatedCompany.save();
        }

        // Generate signed URLs for updated documents
        const companyObj = updatedCompany.toObject();

        // Core Documents
        if (companyObj.tradeLicenseAttachment) {
            companyObj.tradeLicenseAttachment = await getSignedFileUrl(companyObj.tradeLicenseAttachment);
        }
        if (companyObj.establishmentCardAttachment) {
            companyObj.establishmentCardAttachment = await getSignedFileUrl(companyObj.establishmentCardAttachment);
        }
        if (companyObj.logo) {
            companyObj.logo = await getSignedFileUrl(companyObj.logo);
        }

        // Owners Documents
        if (companyObj.owners && Array.isArray(companyObj.owners)) {
            companyObj.owners = await Promise.all(companyObj.owners.map(async (owner) => {
                if (owner.attachment) owner.attachment = await getSignedFileUrl(owner.attachment);
                if (owner.passport?.attachment) owner.passport.attachment = await getSignedFileUrl(owner.passport.attachment);
                if (owner.visa?.attachment) owner.visa.attachment = await getSignedFileUrl(owner.visa.attachment);
                if (owner.emiratesId?.attachment) owner.emiratesId.attachment = await getSignedFileUrl(owner.emiratesId.attachment);
                if (owner.medical?.attachment) owner.medical.attachment = await getSignedFileUrl(owner.medical.attachment);
                if (owner.drivingLicense?.attachment) owner.drivingLicense.attachment = await getSignedFileUrl(owner.drivingLicense.attachment);
                if (owner.labourCard?.attachment) owner.labourCard.attachment = await getSignedFileUrl(owner.labourCard.attachment);
                return owner;
            }));
        }

        // Custom Documents
        if (companyObj.documents && Array.isArray(companyObj.documents)) {
            companyObj.documents = await Promise.all(companyObj.documents.map(async (doc) => {
                if (doc.document?.url) {
                    doc.document.url = await getSignedFileUrl(doc.document.url);
                }
                return doc;
            }));
        }

        // Insurance Records
        if (companyObj.insurance && Array.isArray(companyObj.insurance)) {
            companyObj.insurance = await Promise.all(companyObj.insurance.map(async (item) => {
                if (item.document?.url) {
                    item.document.url = await getSignedFileUrl(item.document.url);
                }
                return item;
            }));
        }

        // Ejari Records
        if (companyObj.ejari && Array.isArray(companyObj.ejari)) {
            companyObj.ejari = await Promise.all(companyObj.ejari.map(async (item) => {
                if (item.document?.url) {
                    item.document.url = await getSignedFileUrl(item.document.url);
                }
                return item;
            }));
        }

        res.status(200).json({
            message: "Company updated successfully",
            company: companyObj,
            activationProgress: calculateCompanyActivationProgress(companyObj)
        });
    } catch (error) {
        console.error("Error updating company:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};
