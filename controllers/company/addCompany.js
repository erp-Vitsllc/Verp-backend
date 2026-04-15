import Company from "../../models/Company.js";
import { calculateCompanyActivationProgress } from "../../utils/companyActivation.js";

export const addCompany = async (req, res) => {
    try {
        const { name, nickName, companyId, email, phone, website, address, city, state, country, registrationNumber, vatNumber, logo, establishedDate } = req.body;

        // Check if companyId already exists
        const existingCompany = await Company.findOne({ companyId });
        if (existingCompany) {
            return res.status(400).json({ message: "Company ID already exists" });
        }

        const newCompany = new Company({
            name,
            nickName,
            companyId,
            email,
            phone,
            website,
            address,
            city,
            state,
            country,
            registrationNumber,
            vatNumber,
            logo,
            establishedDate,
            status: "Inactive",
            activationStatus: "draft",
            createdBy: req.user?._id
        });

        await newCompany.save();

        return res.status(201).json({
            message: "Company added successfully",
            company: newCompany,
            activationProgress: calculateCompanyActivationProgress(newCompany.toObject())
        });
    } catch (error) {
        console.error("Error in addCompany:", error);
        return res.status(500).json({ message: error.message || "Failed to add company" });
    }
};
