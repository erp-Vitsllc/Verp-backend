import Company from "../../models/Company.js";

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

        return res.status(200).json({
            message: "Company fetched successfully",
            company
        });
    } catch (error) {
        console.error("Error fetching company:", error);
        return res.status(500).json({ message: error.message });
    }
};
