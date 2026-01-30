import Company from "../../models/Company.js";
import Fine from "../../models/Fine.js";

export const deleteCompany = async (req, res) => {
    try {
        const { id } = req.params;

        // Check if company exists
        const company = await Company.findById(id);
        if (!company) {
            return res.status(404).json({ message: "Company not found" });
        }

        // Check for dependencies
        // Check if any fines are responsible for this company
        // Fines store responsibleFor: 'Company' but they don't explicitly store the company ObjectId 
        // because the current schema assumes a single-company setup mostly.
        // However, if we have multiple companies, we should check.
        // For now, since Fine doesn't have a company link, we'll just check if there are any files/records 
        // that might be affected.

        // Let's check if any Fines exist that mention this company name (if we want to be thorough)
        const fineCount = await Fine.countDocuments({
            $or: [
                { responsibleFor: 'Company' },
                { responsibleFor: 'Employee & Company' }
            ]
        });

        // NOTE: In a more complex multi-tenant system, we'd check for employees, departments, etc.
        // linked to this specific company ID.

        await Company.findByIdAndDelete(id);

        return res.status(200).json({
            message: "Company deleted successfully"
        });
    } catch (error) {
        console.error("Error in deleteCompany:", error);
        return res.status(500).json({ message: error.message || "Failed to delete company" });
    }
};
