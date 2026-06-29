import EmployeeBasic from '../../models/EmployeeBasic.js';
import EmployeeDrivingLicense from '../../models/EmployeeDrivingLicense.js';
import { isEmployeeProfileLiveActiveForHrQueue } from '../../utils/pushPendingReactivationChange.js';

function hasDrivingLicenseCard(details) {
    if (!details || typeof details !== 'object') return false;
    if (!String(details.number || '').trim()) return false;

    const document = details.document;
    const hasDocument = Boolean(
        document?.url ||
        document?.data ||
        document?.publicId ||
        (typeof document === 'string' && document.trim()),
    );

    return hasDocument;
}

/** Employees with a completed driving license card on profile (for vehicle assignment). */
export const getDrivingLicenseHolders = async (req, res) => {
    try {
        const licenseRows = await EmployeeDrivingLicense.find({
            'drivingLicenceDetails.number': { $exists: true, $nin: [null, ''] },
        })
            .select('employeeId drivingLicenceDetails')
            .lean();

        const eligibleEmployeeIds = licenseRows
            .filter((row) => hasDrivingLicenseCard(row.drivingLicenceDetails))
            .map((row) => row.employeeId)
            .filter(Boolean);

        if (!eligibleEmployeeIds.length) {
            return res.status(200).json({ employees: [] });
        }

        const employees = await EmployeeBasic.find({
            employeeId: { $in: eligibleEmployeeIds },
            status: { $ne: 'Left User' },
            profileStatus: 'active',
            profileApprovalStatus: 'active',
        })
            .select('firstName lastName employeeId profileStatus profileApprovalStatus status')
            .sort({ firstName: 1, lastName: 1 })
            .lean();

        const activeProfileEmployees = employees.filter((employee) =>
            isEmployeeProfileLiveActiveForHrQueue(employee),
        );

        return res.status(200).json({ employees: activeProfileEmployees });
    } catch (error) {
        console.error('getDrivingLicenseHolders:', error);
        return res.status(500).json({ message: 'Failed to load employees with driving license.' });
    }
};
