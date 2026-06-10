import Company from "../../models/Company.js";
import { calculateCompanyActivationProgress } from "../../utils/companyActivation.js";
import { COMPANY_LIST_SELECT, enrichCompaniesForList } from "../../services/companyPartitionService.js";

const COMPANY_RESPONSIBILITIES_PROJECTION = {
    name: 1,
    companyId: 1,
    responsibilities: 1,
};

export const getCompanies = async (req, res) => {
    const t0 = Date.now();
    const ms = (since) => `${Date.now() - since}ms`;
    try {
        const { search, status, scope } = req.query;
        const filters = {};
        const responsibilitiesOnly = scope === "responsibilities";

        if (status) filters.status = status;
        if (search) {
            filters.$or = [
                { name: { $regex: search, $options: "i" } },
                { nickName: { $regex: search, $options: "i" } },
                { companyId: { $regex: search, $options: "i" } },
                { email: { $regex: search, $options: "i" } }
            ];
        }

        // Step 1: list companies without document/archive fields. Some company
        // documents contain large embedded file data, and full reads time out.
        const tList = Date.now();
        const listSelect = responsibilitiesOnly ? COMPANY_RESPONSIBILITIES_PROJECTION : COMPANY_LIST_SELECT;

        let companies = await Company.find(filters)
            .select(listSelect)
            .sort({ createdAt: -1 })
            .lean()
            .maxTimeMS(8000);

        if (!responsibilitiesOnly) {
            companies = await enrichCompaniesForList(companies);
        }
        console.log(`[getCompanies] companies=${companies.length} took=${ms(tList)}`);

        if (responsibilitiesOnly) {
            return res.status(200).json({
                message: "Company responsibilities fetched successfully",
                companies,
                totalCompaniesWithEmployees: 0,
            });
        }

        // Step 2: one aggregation for employee counts (partition-safe EmployeeBasic.company refs).
        const tCount = Date.now();
        const EmployeeBasic = (await import("../../models/EmployeeBasic.js")).default;
        const countByCompany = new Map();
        const companyIds = companies.map((c) => c._id);
        if (companyIds.length > 0) {
            try {
                const grouped = await EmployeeBasic.aggregate([
                    {
                        $match: {
                            company: { $in: companyIds },
                            employeeId: { $ne: "VEGA-HR-0000" },
                            status: { $ne: "Left User" },
                        },
                    },
                    { $group: { _id: "$company", n: { $sum: 1 } } },
                ]).option({ maxTimeMS: 8000 });
                for (const row of grouped) {
                    if (row?._id != null) countByCompany.set(String(row._id), row.n || 0);
                }
            } catch (countErr) {
                console.warn("[getCompanies] employee count aggregation failed:", countErr?.message || countErr);
            }
        }
        console.log(`[getCompanies] employeeCounts took=${ms(tCount)}`);

        // Step 3: sign logo URLs (local crypto, fast but defensive)
        const tSign = Date.now();
        const { getSignedFileUrl } = await import("../../utils/s3Upload.js");
        const finalizedCompanies = await Promise.all(companies.map(async (company) => {
            company.employeeCount = countByCompany.get(String(company._id)) || 0;
            if (company.logo) {
                try {
                    company.logo = await getSignedFileUrl(company.logo);
                } catch (err) {
                    console.warn("getCompanies: failed to sign logo for", company._id, err.message);
                }
            }
            try {
                company.activationProgress = calculateCompanyActivationProgress(company);
            } catch (progressErr) {
                console.warn("getCompanies: activation progress failed for", company._id, progressErr?.message);
                company.activationProgress = { percentage: 0, checks: [] };
            }
            return company;
        }));
        console.log(`[getCompanies] sign+progress took=${ms(tSign)} total=${ms(t0)}`);

        const totalCompaniesWithEmployees = finalizedCompanies.filter(c => c.employeeCount > 0).length;

        return res.status(200).json({
            message: "Companies fetched successfully",
            companies: finalizedCompanies,
            totalCompaniesWithEmployees
        });
    } catch (error) {
        console.error(`Error in getCompanies (after ${ms(t0)}):`, error);
        return res.status(500).json({ message: error.message || "Failed to fetch companies" });
    }
};
