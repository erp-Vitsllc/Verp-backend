import { hasPermission, isUserAdministrator } from '../../services/permissionService.js';
import { generateSalarySlipPdfBuffer } from '../../utils/generateSalarySlipPdf.js';
import { defaultSalarySlipMonthKey, monthKeyOf, SalarySlipError } from '../../utils/buildSalarySlipPayload.js';

async function userCanViewSalarySetup(req) {
    const userId = req.user?.id || req.user?._id;
    if (!userId) return false;
    if (await isUserAdministrator(userId)) return true;
    return (
        (await hasPermission(userId, 'hrm_salary', 'edit')) ||
        (await hasPermission(userId, 'hrm_employees_view_salary', 'edit')) ||
        (await hasPermission(userId, 'hrm_salary', 'isView')) ||
        (await hasPermission(userId, 'hrm_employees_view_salary', 'isView'))
    );
}

/**
 * GET /api/Employee/salary-enroll/:employeeId/historical/salary-slip
 * Opens this employee's monthly salary slip PDF (preview on enroll, email when Salary slip is checked).
 */
export async function downloadSalarySlipPdf(req, res) {
    try {
        const employeeId = String(req.params.employeeId || '').trim();
        if (!employeeId) {
            return res.status(400).json({ message: 'Employee is required.' });
        }
        if (!(await userCanViewSalarySetup(req))) {
            return res.status(403).json({ message: 'You do not have permission to open this salary slip.' });
        }

        const monthKey = monthKeyOf(req.query.month || req.query.monthKey) || defaultSalarySlipMonthKey();
        const { buffer, slip } = await generateSalarySlipPdfBuffer({ employeeId, monthKey });
        if (!buffer) {
            return res.status(500).json({ message: 'Failed to generate salary slip.' });
        }

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader(
            'Content-Disposition',
            `inline; filename="${slip.fileName || `Salary-Slip-${employeeId}.pdf`}"`,
        );
        res.setHeader('Cache-Control', 'private, no-store');
        return res.send(buffer);
    } catch (error) {
        const status = error instanceof SalarySlipError ? error.statusCode : 500;
        console.error('[downloadSalarySlipPdf]', error?.message || error);
        return res.status(status).json({
            message: error.message || 'Failed to open salary slip.',
        });
    }
}
