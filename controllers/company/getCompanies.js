import Company from "../../models/Company.js";

export const getCompanies = async (req, res) => {
    try {
        const { search, status } = req.query;
        const filters = {};

        if (status) filters.status = status;
        if (search) {
            filters.$or = [
                { name: { $regex: search, $options: "i" } },
                { companyId: { $regex: search, $options: "i" } },
                { email: { $regex: search, $options: "i" } }
            ];
        }

        const companies = await Company.find(filters).sort({ createdAt: -1 });

        const { getSignedFileUrl } = await import("../../utils/s3Upload.js");

        const processedCompanies = await Promise.all(companies.map(async (company) => {
            const companyObj = company.toObject();
            if (companyObj.logo) {
                companyObj.logo = await getSignedFileUrl(companyObj.logo);
            }
            return companyObj;
        }));

        return res.status(200).json({
            message: "Companies fetched successfully",
            companies: processedCompanies
        });
    } catch (error) {
        console.error("Error in getCompanies:", error);
        return res.status(500).json({ message: error.message || "Failed to fetch companies" });
    }
};
