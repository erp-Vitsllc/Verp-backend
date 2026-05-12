import Company from "../../models/Company.js";
import { calculateCompanyActivationProgress } from "../../utils/companyActivation.js";

// Exclude the heavy archive/snapshot fields so list reads stay fast.
// Everything else is returned as-is.
const COMPANY_LIST_EXCLUSIONS = {
    oldDocuments: 0,
    oldOwners: 0,
    "pendingReactivationChanges.previousData": 0,
};

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
        const companies = await Company.find(filters)
            .select(responsibilitiesOnly ? COMPANY_RESPONSIBILITIES_PROJECTION : COMPANY_LIST_EXCLUSIONS)
            .sort({ createdAt: -1 })
            .lean()
            .maxTimeMS(8000);
        console.log(`[getCompanies] companies=${companies.length} took=${ms(tList)}`);

        if (responsibilitiesOnly) {
            return res.status(200).json({
                message: "Company responsibilities fetched successfully",
                companies,
                totalCompaniesWithEmployees: 0,
            });
        }

        // Step 2: count employees per company with a strict per-company timeout.
        // We never let this step hang the whole request — if a count is slow,
        // we return 0 and continue. Keep the budget short so the page loads.
        const tCount = Date.now();
        const COUNT_BUDGET_MS = 4000;
        const EmployeeBasic = (await import("../../models/EmployeeBasic.js")).default;
        const countByCompany = new Map();
        const countResults = await Promise.allSettled(
            companies.map((c) =>
                EmployeeBasic.countDocuments({
                    company: c._id,
                    employeeId: { $ne: "VEGA-HR-0000" },
                })
                    .maxTimeMS(COUNT_BUDGET_MS)
                    .then((n) => ({ id: String(c._id), n }))
            )
        );
        let countFailures = 0;
        for (const r of countResults) {
            if (r.status === "fulfilled") {
                countByCompany.set(r.value.id, r.value.n);
            } else {
                countFailures += 1;
            }
        }
        if (countFailures > 0) {
            console.warn(
                `[getCompanies] employeeCounts: ${countFailures}/${companies.length} timed out — returning 0 for those`
            );
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
            company.activationProgress = calculateCompanyActivationProgress(company);
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
