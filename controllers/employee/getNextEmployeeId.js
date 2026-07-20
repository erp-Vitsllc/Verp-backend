import EmployeeBasic from '../../models/EmployeeBasic.js';
import Company from '../../models/Company.js';
import EmployeeContact from '../../models/EmployeeContact.js';
import { resolveEmployeeIdPrefixFromCompany } from '../../utils/employeeIdPrefix.js';

// Get next sequential Employee ID (prefix from company; number +1 under that prefix)
export const getNextEmployeeId = async (req, res) => {
    try {
        const { companyId } = req.query;
        let prefix = 'VEGA-HR-';

        if (companyId) {
            const company = await Company.findById(companyId).select('name nickName').lean();
            if (company) {
                prefix = resolveEmployeeIdPrefixFromCompany(company);
            }
        }

        // Fetch all IDs matching the prefix to find the truly largest numeric value
        const regex = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$')}\\d+$`, 'i');

        const [employees, contacts] = await Promise.all([
            EmployeeBasic.find({
                employeeId: { $regex: regex },
            })
                .select('employeeId')
                .lean(),
            EmployeeContact.find({
                employeeId: { $regex: regex },
            })
                .select('employeeId')
                .lean(),
        ]);

        let maxIdNumber = 0;
        const allIds = [...employees, ...contacts];

        allIds.forEach((emp) => {
            const match = String(emp.employeeId || '').match(/\d+$/);
            if (match) {
                const num = parseInt(match[0], 10);
                if (!Number.isNaN(num) && num > maxIdNumber) {
                    maxIdNumber = num;
                }
            }
        });

        const nextIdNumber = maxIdNumber + 1;
        const nextId = `${prefix}${String(nextIdNumber).padStart(5, '0')}`.toUpperCase();

        return res.status(200).json({
            nextEmployeeId: nextId,
            prefix,
        });
    } catch (error) {
        console.error('Error generating next employee ID:', error);
        return res.status(500).json({
            message: 'Failed to generate employee ID',
            error: error.message,
        });
    }
};

export { resolveEmployeeIdPrefixFromCompany };
