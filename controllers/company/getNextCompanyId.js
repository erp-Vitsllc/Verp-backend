import Company from "../../models/Company.js";

export const getNextCompanyId = async (req, res) => {
    try {
        const lastCompany = await Company.findOne({
            companyId: { $regex: /^EST-\d+$/ }
        }).sort({ createdAt: -1 }).select('companyId');

        let nextNumber = 1;

        if (lastCompany && lastCompany.companyId) {
            const match = lastCompany.companyId.match(/\d+$/);
            if (match) {
                nextNumber = parseInt(match[0], 10) + 1;
            }
        }

        const nextId = `EST-${String(nextNumber).padStart(3, '0')}`;

        return res.status(200).json({ nextCompanyId: nextId });
    } catch (error) {
        console.error('Error generating next company ID:', error);
        return res.status(500).json({ message: 'Failed to generate company ID' });
    }
};
