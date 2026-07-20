import EmployeeBasic from '../../models/EmployeeBasic.js';
import Company from '../../models/Company.js';
import EmployeeContact from '../../models/EmployeeContact.js';
import { resolveEmployeeIdPrefixFromCompany } from '../../utils/employeeIdPrefix.js';

/**
 * Next Employee ID:
 * - Prefix VEGA-HR- / NNIT-HR- from company name
 * - Serial number is global across VEGA + NNIT (max existing + 1)
 *   e.g. VEGA-HR-00010 exists → next NNIT hire is NNIT-HR-00011
 */
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

        // Serial is shared: scan both VEGA-HR-#### and NNIT-HR-#### (ignore company placeholders like …0000)
        const serialRegex = /^(VEGA|NNIT)-HR-(\d+)$/i;

        const [employees, contacts] = await Promise.all([
            EmployeeBasic.find({
                employeeId: { $regex: /^(VEGA|NNIT)-HR-\d+$/i },
            })
                .select('employeeId')
                .lean(),
            EmployeeContact.find({
                employeeId: { $regex: /^(VEGA|NNIT)-HR-\d+$/i },
            })
                .select('employeeId')
                .lean(),
        ]);

        let maxIdNumber = 0;
        const allIds = [...employees, ...contacts];

        allIds.forEach((emp) => {
            const match = String(emp.employeeId || '').match(serialRegex);
            if (!match) return;
            const num = parseInt(match[2], 10);
            // Skip placeholder company party IDs (…0000)
            if (!Number.isNaN(num) && num > 0 && num > maxIdNumber) {
                maxIdNumber = num;
            }
        });

        const nextIdNumber = maxIdNumber + 1;
        const nextId = `${prefix}${String(nextIdNumber).padStart(5, '0')}`.toUpperCase();

        return res.status(200).json({
            nextEmployeeId: nextId,
            prefix,
            nextSerial: nextIdNumber,
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
