import Company from "../../models/Company.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { calculateCompanyActivationProgress } from "../../utils/companyActivation.js";
import { isRequestUserDesignatedFlowchartHr } from "../../utils/isDesignatedFlowchartHr.js";
import { signCompanyDocumentArray } from "../../utils/signCompanyDocumentFields.js";
import { loadCompanyFullProfile } from "../../services/companyPartitionService.js";

/**
 * Get a single company by its companyId (e.g., EST-001)
 */
export const getCompany = async (req, res) => {
    try {
        const id = String(req.params.id || "").trim();
        if (!id) {
            return res.status(400).json({ message: "Company id is required" });
        }

        // Try exact companyId, then case-insensitive code (e.g. EST-006), then Mongo _id
        let company = await Company.findOne({ companyId: id }).maxTimeMS(8000);

        if (!company) {
            const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            company = await Company.findOne({
                companyId: { $regex: new RegExp(`^${escaped}$`, "i") },
            }).maxTimeMS(8000);
        }

        if (!company && id.match(/^[0-9a-fA-F]{24}$/)) {
            company = await Company.findById(id).maxTimeMS(8000);
        }

        if (!company) {
            return res.status(404).json({ message: "Company not found" });
        }

        // Get employee count (excluding placeholder) for this specific company
        const employeeCount = await EmployeeBasic.countDocuments({
            company: company._id,
            employeeId: { $ne: "VEGA-HR-0000" }
        });

        const companyObj = await loadCompanyFullProfile(company);
        if (!companyObj) {
            return res.status(404).json({ message: "Company not found" });
        }

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

        // Owners Documents (arrays may contain null placeholders)
        if (companyObj.owners && Array.isArray(companyObj.owners)) {
            companyObj.owners = await Promise.all(companyObj.owners.map(async (owner) => {
                if (!owner || typeof owner !== "object") return owner;
                if (owner.attachment) owner.attachment = await getSignedFileUrl(owner.attachment);
                if (owner.passport?.attachment) owner.passport.attachment = await getSignedFileUrl(owner.passport.attachment);
                if (owner.visa?.attachment) owner.visa.attachment = await getSignedFileUrl(owner.visa.attachment);
                for (const visaKey of ["visitVisa", "employmentVisa", "spouseVisa"]) {
                    if (owner[visaKey]?.attachment) {
                        owner[visaKey].attachment = await getSignedFileUrl(owner[visaKey].attachment);
                    }
                }
                if (owner.emiratesId?.attachment) owner.emiratesId.attachment = await getSignedFileUrl(owner.emiratesId.attachment);
                if (owner.medical?.attachment) owner.medical.attachment = await getSignedFileUrl(owner.medical.attachment);
                if (owner.drivingLicense?.attachment) owner.drivingLicense.attachment = await getSignedFileUrl(owner.drivingLicense.attachment);
                if (owner.labourCard?.attachment) owner.labourCard.attachment = await getSignedFileUrl(owner.labourCard.attachment);
                return owner;
            }));
        }

        // Custom / archived / insurance / ejari rows (document.url + legacy attachment)
        if (companyObj.documents) {
            companyObj.documents = await signCompanyDocumentArray(companyObj.documents);
        }
        if (companyObj.insurance) {
            companyObj.insurance = await signCompanyDocumentArray(companyObj.insurance);
        }
        if (companyObj.ejari) {
            companyObj.ejari = await signCompanyDocumentArray(companyObj.ejari);
        }
        if (companyObj.oldDocuments) {
            companyObj.oldDocuments = await signCompanyDocumentArray(companyObj.oldDocuments);
        }

        const viewerIsDesignatedFlowchartHr = await isRequestUserDesignatedFlowchartHr(req);

        if (Array.isArray(companyObj.pendingNotRenewRequests) && companyObj.pendingNotRenewRequests.length) {
            for (const p of companyObj.pendingNotRenewRequests) {
                const key = (p.supportingAttachmentKey || "").trim();
                if (key) {
                    try {
                        p.supportingAttachmentUrl = await getSignedFileUrl(key);
                    } catch {
                        p.supportingAttachmentUrl = "";
                    }
                }
            }
        }

        // --- FETCH COMPANY ASSETS (Direct Company Assignments Only) ---
        // Find assets assigned specifically to this company
        const companyAssets = await AssetItem.find({
            assignedCompany: company._id,
            assignedToType: 'Company',
            status: { $ne: 'Draft' } // Don't show drafts in company profile
        }).populate({
            path: 'assignedTo',
            select: 'firstName lastName employeeId designation'
        }).populate('typeId', 'name').populate('categoryId', 'name');


        // 3. Sign URLs for asset artifacts
        companyObj.assets = await Promise.all(companyAssets.map(async (asset) => {
            const assetObj = asset.toObject();
            if (assetObj.photo) assetObj.photo = await getSignedFileUrl(assetObj.photo);
            if (assetObj.invoiceFile) assetObj.invoiceFile = await getSignedFileUrl(assetObj.invoiceFile);
            return assetObj;
        }));


        return res.status(200).json({
            message: "Company fetched successfully",
            company: companyObj,
            employeeCount: employeeCount,
            activationProgress: calculateCompanyActivationProgress(companyObj),
            viewerIsDesignatedFlowchartHr,
        });
    } catch (error) {
        console.error("Error fetching company:", error);
        return res.status(500).json({ message: error.message });
    }
};
