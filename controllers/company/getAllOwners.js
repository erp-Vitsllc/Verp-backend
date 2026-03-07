import Company from "../../models/Company.js";

/**
 * GET /api/Company/all-owners
 * Returns all owners from all companies, each tagged with companyName & companyId.
 * Used by the Trade License owner picker dropdown.
 */
export const getAllOwners = async (req, res) => {
    try {
        const companies = await Company.find(
            { "owners.0": { $exists: true } }, // only companies that have at least one owner
            { name: 1, companyId: 1, owners: 1, _id: 1 }
        ).lean();

        const ownerPool = [];
        for (const comp of companies) {
            for (const owner of comp.owners || []) {
                if (owner.name) {
                    ownerPool.push({
                        ...owner,
                        _companyName: comp.name,
                        _companyId: comp._id,
                        _companyCode: comp.companyId,
                    });
                }
            }
        }

        return res.status(200).json({ owners: ownerPool });
    } catch (error) {
        console.error("Error in getAllOwners:", error);
        return res.status(500).json({ message: error.message || "Failed to fetch owners" });
    }
};
