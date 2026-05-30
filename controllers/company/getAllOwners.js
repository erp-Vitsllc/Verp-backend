import Company from "../../models/Company.js";
import CompanyOwners from "../../models/CompanyOwners.js";
import { normalizeOwnerProfileId } from "../../utils/ownerProfileId.js";

function ownerInfoScore(owner) {
    if (!owner) return 0;
    let score = 0;
    const fields = ["email", "phone", "passport", "visa", "emiratesId", "nationality", "labourCard"];
    for (const field of fields) {
        const value = owner[field];
        if (!value) continue;
        if (typeof value === "object") {
            if (value.number || value.attachment) score += 5;
        } else if (String(value).trim() !== "") {
            score += 5;
        }
    }
    return score;
}

/**
 * GET /api/Company/all-owners
 * Returns deduplicated owners (by ownerProfileId) from all companies.
 * Reads partitioned CompanyOwners rows and legacy Company.owners.
 */
export const getAllOwners = async (req, res) => {
    try {
        const companies = await Company.find({}, { name: 1, companyId: 1, owners: 1, dataPartitionVersion: 1 })
            .lean()
            .maxTimeMS(10000);
        const companyMap = new Map(companies.map((c) => [String(c._id), c]));

        const ownerPartitions = await CompanyOwners.find({ "owners.0": { $exists: true } })
            .select({ company: 1, owners: 1 })
            .lean()
            .maxTimeMS(10000);

        const byProfileId = new Map();

        const consider = (owner, comp) => {
            const name = owner?.name != null ? String(owner.name).trim() : "";
            if (!name) return;
            const profileId = normalizeOwnerProfileId(owner?.ownerProfileId);
            if (!profileId) return;

            const companyName = comp?.name || comp?.companyId || "Unknown";
            const score = ownerInfoScore(owner);
            const prev = byProfileId.get(profileId);
            if (!prev || score > prev.score) {
                byProfileId.set(profileId, {
                    owner: {
                        name,
                        email: owner.email || "",
                        phone: owner.phone || "",
                        nationality: owner.nationality || "",
                        sharePercentage: owner.sharePercentage || "",
                        ownerProfileId: profileId,
                    },
                    fromCompany: companyName,
                    score,
                });
            }
        };

        for (const row of ownerPartitions) {
            const comp = companyMap.get(String(row.company));
            for (const owner of row.owners || []) {
                consider(owner, comp);
            }
        }

        for (const comp of companies) {
            if (Number(comp.dataPartitionVersion) >= 1) continue;
            for (const owner of comp.owners || []) {
                consider(owner, comp);
            }
        }

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
