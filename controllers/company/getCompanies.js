import Company from "../../models/Company.js";
import { calculateCompanyActivationProgress } from "../../utils/companyActivation.js";

export const getCompanies = async (req, res) => {
    try {
        const { search, status } = req.query;
        const filters = {};

        if (status) filters.status = status;
        if (search) {
            filters.$or = [
                { name: { $regex: search, $options: "i" } },
                { nickName: { $regex: search, $options: "i" } },
                { companyId: { $regex: search, $options: "i" } },
                { email: { $regex: search, $options: "i" } }
            ];
        }

        // Use aggregation to count employees for each company
        const processedCompanies = await Company.aggregate([
            { $match: filters },
            { $sort: { createdAt: -1 } },
            {
                $lookup: {
                    from: "employeebasics",
                    let: { companyId: "$_id" },
                    pipeline: [
                        {
                            $match: {
                                $expr: { $eq: ["$company", "$$companyId"] },
                                employeeId: { $ne: "VEGA-HR-0000" }
                            }
                        }
                    ],
                    as: "employees"
                }
            },
            {
                $addFields: {
                    employeeCount: { $size: "$employees" }
                }
            },
            { $project: { employees: 0 } }
        ]);

        const { getSignedFileUrl } = await import("../../utils/s3Upload.js");

        const finalizedCompanies = await Promise.all(processedCompanies.map(async (company) => {
            if (company.logo) {
                company.logo = await getSignedFileUrl(company.logo);
            }
            company.activationProgress = calculateCompanyActivationProgress(company);
            return company;
        }));

        const totalCompaniesWithEmployees = finalizedCompanies.filter(c => c.employeeCount > 0).length;

        return res.status(200).json({
            message: "Companies fetched successfully",
            companies: finalizedCompanies,
            totalCompaniesWithEmployees
        });
    } catch (error) {
        console.error("Error in getCompanies:", error);
        return res.status(500).json({ message: error.message || "Failed to fetch companies" });
    }
};
