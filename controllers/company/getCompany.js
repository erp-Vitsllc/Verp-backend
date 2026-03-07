import Company from "../../models/Company.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";

/**
 * Get a single company by its companyId (e.g., EST-001)
 */
export const getCompany = async (req, res) => {
    try {
        const { id } = req.params;

        // Try finding by companyId first, then by _id
        let company = await Company.findOne({ companyId: id });

        if (!company && id.match(/^[0-9a-fA-F]{24}$/)) {
            company = await Company.findById(id);
        }

        if (!company) {
            return res.status(404).json({ message: "Company not found" });
        }

        // Get employee count (excluding placeholder) for this specific company
        const employeeCount = await EmployeeBasic.countDocuments({
            company: company._id,
            employeeId: { $ne: "VEGA-HR-0000" }
        });

        // Generate signed URLs for all documents
        const companyObj = company.toObject();

        const { getSignedFileUrl } = await import("../../utils/s3Upload.js");
        const AssetItem = await import("../../models/AssetItem.js").then(m => m.default);

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

        // Add Financial stats to responsibilities for FlowChart display
        if (companyObj.responsibilities && Array.isArray(companyObj.responsibilities)) {
            for (const resp of companyObj.responsibilities) {
                if (resp.empObjectId) {
                    try {
                        const assets = await AssetItem.find({ assignedTo: resp.empObjectId, status: 'Assigned' });
                        let totalAssetValue = 0;
                        let totalAccValue = 0;

                        assets.forEach(asset => {
                            totalAssetValue += (Number(asset.assetValue) || 0);
                            if (asset.accessories && Array.isArray(asset.accessories)) {
                                asset.accessories.forEach(acc => {
                                    if (acc.status === 'Attached') {
                                        totalAccValue += (Number(acc.amount) || 0);
                                    }
                                });
                            }
                        });

                        resp.financials = {
                            assetValue: totalAssetValue,
                            accValue: totalAccValue
                        };
                    } catch (err) {
                        console.error(`Error calculating financials for employee ${resp.employeeId}:`, err);
                        resp.financials = { assetValue: 0, accValue: 0 };
                    }
                }
            }
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

        return res.status(200).json({
            message: "Company fetched successfully",
            company: companyObj,
            employeeCount: employeeCount
        });
    } catch (error) {
        console.error("Error fetching company:", error);
        return res.status(500).json({ message: error.message });
    }
};
