import { loadGlobalOwnersCatalogMap } from "../../utils/globalOwnersCatalog.js";

/**
 * GET /api/Company/all-owners
 * Returns deduplicated owners (by ownerProfileId) from all companies.
 * Includes passport / Emirates ID / visa / other nested docs from the richest row.
 */
export const getAllOwners = async (req, res) => {
    try {
        const byProfileId = await loadGlobalOwnersCatalogMap();

        const owners = Array.from(byProfileId.values()).map(({ owner, fromCompany }) => ({
            ...owner,
            fromCompany,
        }));

        return res.status(200).json({ owners });
    } catch (error) {
        console.error("Error in getAllOwners:", error);
        return res.status(500).json({ message: error.message || "Failed to fetch owners" });
    }
};
