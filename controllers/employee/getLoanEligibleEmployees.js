import EmployeeBasic from "../../models/EmployeeBasic.js";
import EmployeeSalary from "../../models/EmployeeSalary.js";
import EmployeeVisa from "../../models/EmployeeVisa.js";

function visaFromRecord(visa) {
    if (visa?.employment?.expiryDate) {
        return { type: 'Employment', expiry: visa.employment.expiryDate };
    }
    if (visa?.spouse?.expiryDate) {
        return { type: 'Spouse', expiry: visa.spouse.expiryDate };
    }
    if (visa?.visit?.expiryDate) {
        return { type: 'Visit', expiry: visa.visit.expiryDate };
    }
    return { type: null, expiry: null };
}

function toEligibleEmployee(emp, salary = 0, visaInfo = null) {
    return {
        employeeId: emp.employeeId,
        employeeObjectId: emp._id,
        name: `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || 'Employee',
        status: emp.status,
        salary: Number(salary) || 0,
        visaExpiry: visaInfo?.expiry || null,
        visaType: visaInfo?.type || null,
    };
}

async function resolveSelfBasic(req) {
    if (req.user?.employeeObjectId) {
        const byOid = await EmployeeBasic.findById(req.user.employeeObjectId)
            .select('_id employeeId firstName lastName status')
            .lean();
        if (byOid) return byOid;
    }
    if (req.user?.employeeId) {
        return EmployeeBasic.findOne({ employeeId: req.user.employeeId })
            .select('_id employeeId firstName lastName status')
            .lean();
    }
    return null;
}

export const getLoanEligibleEmployees = async (req, res) => {
    try {
        const employees = await EmployeeBasic.find(
            { profileStatus: 'active' },
            'employeeId firstName lastName status'
        ).lean();

        if (!employees.length) {
            return res.status(200).json({ employees: [] });
        }

        const employeeIds = employees.map((e) => e.employeeId);

        const salaries = await EmployeeSalary.find(
            { employeeId: { $in: employeeIds } },
            'employeeId totalSalary monthlySalary'
        ).lean();

        const visas = await EmployeeVisa.find(
            { employeeId: { $in: employeeIds } },
            'employeeId employment.expiryDate spouse.expiryDate visit.expiryDate'
        ).lean();

        const salaryMap = salaries.reduce((acc, curr) => {
            acc[curr.employeeId] = curr.totalSalary || curr.monthlySalary || 0;
            return acc;
        }, {});

        const visaMap = visas.reduce((acc, curr) => {
            acc[curr.employeeId] = visaFromRecord(curr);
            return acc;
        }, {});

        const eligibleEmployees = employees.map((emp) =>
            toEligibleEmployee(emp, salaryMap[emp.employeeId] || 0, visaMap[emp.employeeId]),
        );

        res.status(200).json({ employees: eligibleEmployees });
    } catch (error) {
        console.error("Error fetching loan eligible employees:", error);
        res.status(500).json({ message: "Failed to fetch employee eligibility data" });
    }
};

/**
 * GET /api/Employee/dashboard/my-loan-profile
 * Current user's employee row in the shape Add Loan / Advance expects.
 */
export const getMyLoanProfile = async (req, res) => {
    try {
        const self = await resolveSelfBasic(req);
        if (!self) {
            return res.status(404).json({
                message: 'No linked employee profile found for this user.',
            });
        }

        const [salary, visa] = await Promise.all([
            EmployeeSalary.findOne(
                { employeeId: self.employeeId },
                'employeeId totalSalary monthlySalary',
            ).lean(),
            EmployeeVisa.findOne(
                { employeeId: self.employeeId },
                'employeeId employment.expiryDate spouse.expiryDate visit.expiryDate',
            ).lean(),
        ]);

        return res.status(200).json({
            employee: toEligibleEmployee(
                self,
                salary?.totalSalary || salary?.monthlySalary || 0,
                visaFromRecord(visa),
            ),
        });
    } catch (error) {
        console.error('Error fetching my loan profile:', error);
        return res.status(500).json({ message: 'Failed to load your employee profile.' });
    }
};
