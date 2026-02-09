import Company from "../../models/Company.js";

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

        if (updateData.responsibilities && Array.isArray(updateData.responsibilities)) {
            const EmployeeBasic = (await import("../../models/EmployeeBasic.js")).default;
            const User = (await import("../../models/User.js")).default;

            const existingResps = company.responsibilities || [];

            for (const resp of updateData.responsibilities) {
                if (!resp.employeeId) continue;

                // Check if this specific assignment already exists to allow simple removals or non-responsibility updates
                const isExisting = existingResps.some(er =>
                    er.employeeId === resp.employeeId &&
                    er.category === resp.category
                );

                if (isExisting) continue;

                // Check employee exists and has company email
                const employee = await EmployeeBasic.findOne({ employeeId: resp.employeeId });
                if (!employee) {
                    return res.status(400).json({ message: `Employee ${resp.employeeId} not found` });
                }

                if (!employee.companyEmail) {
                    return res.status(400).json({
                        message: `Employee ${employee.firstName} ${employee.lastName} (${resp.employeeId}) cannot be assigned a responsibility because they do not have a company email address.`
                    });
                }

                // Check if employee is also a user
                const user = await User.findOne({ employeeId: resp.employeeId });
                if (!user) {
                    return res.status(400).json({
                        message: `Employee ${employee.firstName} ${employee.lastName} (${resp.employeeId}) cannot be assigned a responsibility because they are not registered as a system user.`
                    });
                }
            }
        }

        const updatedCompany = await Company.findByIdAndUpdate(
            company._id,
            { $set: updateData },
            { new: true, runValidators: true }
        );

        // Generate signed URLs for updated documents
        const companyObj = updatedCompany.toObject();
        const { getSignedFileUrl } = await import("../../utils/s3Upload.js");

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
            company: companyObj
        });
    } catch (error) {
        console.error("Error updating company:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};
