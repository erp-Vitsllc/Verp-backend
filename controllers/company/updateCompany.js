import Company from "../../models/Company.js";

export const updateCompany = async (req, res) => {
    try {
        const { id } = req.params;

        // Find by _id or companyId
        let company = await Company.findOne({
            $or: [{ _id: id.match(/^[0-9a-fA-F]{24}$/) ? id : null }, { companyId: id }]
        });

        if (!company) {
            return res.status(404).json({ message: "Company not found" });
        }

        // Update fields provided in req.body
        const updateData = req.body;

        // Prevent updating companyId if it already exists (immutable)
        delete updateData.companyId;

        const updatedCompany = await Company.findByIdAndUpdate(
            company._id,
            { $set: updateData },
            { new: true, runValidators: true }
        );

        res.status(200).json({
            message: "Company updated successfully",
            company: updatedCompany
        });
    } catch (error) {
        console.error("Error updating company:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};
