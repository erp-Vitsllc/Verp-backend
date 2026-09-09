import mongoose from 'mongoose';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import PayrollSettings from '../../models/PayrollSettings.js';
import SalaryEnrollment from '../../models/SalaryEnrollment.js';
import SalaryHistoricalProfile from '../../models/SalaryHistoricalProfile.js';
import SalaryMonthPayment from '../../models/SalaryMonthPayment.js';
import SalarySlipMonth from '../../models/SalarySlipMonth.js';
import { hasPermission, isUserAdministrator } from '../../services/permissionService.js';
import { generateSalarySlipPdfBuffer } from '../../utils/generateSalarySlipPdf.js';
import {
    applySalarySlipOverride,
    buildSalarySlipPayload,
    defaultSalarySlipMonthKey,
    monthKeyOf,
    SalarySlipError,
    serializeSalarySlipForClient,
    summarizeSalarySlipListRow,
} from '../../utils/buildSalarySlipPayload.js';
import {
    salarySlipMonthAllowed,
    salarySlipMonthRange,
    salaryYearMonth,
} from '../../utils/salaryEnrollmentStartMonth.js';

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

async function userCanEditSalarySetup(req) {
    const userId = req.user?.id || req.user?._id;
    if (!userId) return false;
    if (await isUserAdministrator(userId)) return true;
    return (
        (await hasPermission(userId, 'hrm_salary', 'edit')) ||
        (await hasPermission(userId, 'hrm_employees_view_salary', 'edit'))
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
        const gate = await loadSalarySlipEnrollment(employeeId);
        if (!salarySlipMonthAllowed(monthKey, gate)) {
            return res.status(400).json({ message: slipMonthDeniedMessage(gate.enrolled, gate.fromMonth) });
        }
        if (String(req.query.format || '').toLowerCase() === 'json') {
            const slip = await buildSalarySlipPayload({ employeeId, monthKey });
            return res.json({ slip: serializeSalarySlipForClient(slip) });
        }

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

function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function loadSalarySlipEnrollment(employeeId) {
    const emp = await EmployeeBasic.findOne({ employeeId }).select('employeeId').lean();
    const code = String(emp?.employeeId || employeeId).trim();
    const enrollment = await SalaryEnrollment.findOne({
        employeeId: new RegExp(`^${escapeRegex(code)}$`, 'i'),
    })
        .select('fromMonth')
        .lean();
    return {
        code,
        enrolled: Boolean(enrollment),
        fromMonth: salaryYearMonth(enrollment?.fromMonth),
    };
}

function slipMonthDeniedMessage(enrolled, fromMonth) {
    if (!enrolled) {
        return 'Salary slips start on the 1st of the month after this employee is enrolled.';
    }
    const start = salaryYearMonth(fromMonth);
    return start
        ? `Salary slips start from ${start}.`
        : 'Salary slips start on the 1st of the month after enrollment.';
}

/**
 * GET /api/Employee/salary-enroll/:employeeId/historical/salary-slips
 * Unenrolled employees have no months. After enroll, the first slip appears
 * on the 1st of the following month, then each later month on its 1st.
 */
export async function listEmployeeSalarySlipMonths(req, res) {
    try {
        const employeeId = String(req.params.employeeId || '').trim();
        if (!employeeId) {
            return res.status(400).json({ message: 'Employee is required.' });
        }
        if (!(await userCanViewSalarySetup(req))) {
            return res.status(403).json({ message: 'You do not have permission to view salary slips.' });
        }

        const emp = await EmployeeBasic.findOne({ employeeId }).select('employeeId').lean();
        const code = String(emp?.employeeId || employeeId).trim();
        const idPattern = new RegExp(`^${escapeRegex(code)}$`, 'i');

        const [enrollment, profile, payments, payrollDoc] = await Promise.all([
            SalaryEnrollment.findOne({ employeeId: idPattern }).select('fromMonth').lean(),
            SalaryHistoricalProfile.findOne({ employeeId: idPattern }).select('verpStartDate').lean(),
            SalaryMonthPayment.find({ employeeIds: idPattern })
                .select('monthKey paymentNo createdAt')
                .sort({ monthKey: -1, paymentNo: -1 })
                .lean(),
            PayrollSettings.findOne({ key: 'default' }).select('salaryProcessStartMonth').lean(),
        ]);

        const enrolled = Boolean(enrollment);
        const fromMonth = salaryYearMonth(enrollment?.fromMonth);
        const monthKeys = salarySlipMonthRange({
            enrolled,
            fromMonth,
            verpStartYm: monthKeyOf(profile?.verpStartDate),
            policyStartYm: monthKeyOf(payrollDoc?.salaryProcessStartMonth),
        }).reverse();

        const paymentByMonth = new Map();
        for (const doc of payments || []) {
            const ym = monthKeyOf(doc.monthKey);
            if (!ym || paymentByMonth.has(ym)) continue;
            paymentByMonth.set(ym, doc);
        }

        const months = [];
        for (const ym of monthKeys) {
            const payment = paymentByMonth.get(ym);
            try {
                const slip = await buildSalarySlipPayload({ employeeId: code, monthKey: ym });
                months.push({
                    ...summarizeSalarySlipListRow(slip),
                    paymentNo: Number(payment?.paymentNo) || 0,
                    processedAt: payment?.createdAt || null,
                });
            } catch (error) {
                console.error('[listEmployeeSalarySlipMonths]', ym, error?.message || error);
                months.push({
                    ...summarizeSalarySlipListRow({ monthKey: ym }),
                    paymentNo: Number(payment?.paymentNo) || 0,
                    processedAt: payment?.createdAt || null,
                });
            }
        }

        return res.json({
            employeeId: code,
            enrolled,
            fromMonth,
            months,
        });
    } catch (error) {
        console.error('[listEmployeeSalarySlipMonths]', error?.message || error);
        return res.status(500).json({ message: error.message || 'Failed to load salary months.' });
    }
}

/**
 * PUT /api/Employee/salary-enroll/:employeeId/historical/salary-slip
 * Save edited slip fields for this month. Totals are recomputed from connected rows.
 */
export async function saveSalarySlipMonth(req, res) {
    try {
        const employeeId = String(req.params.employeeId || '').trim();
        if (!employeeId) {
            return res.status(400).json({ message: 'Employee is required.' });
        }
        if (!(await userCanEditSalarySetup(req))) {
            return res.status(403).json({ message: 'You do not have permission to update this salary slip.' });
        }

        const monthKey = monthKeyOf(req.body?.monthKey || req.body?.month || req.query.month);
        if (!monthKey) {
            return res.status(400).json({ message: 'Salary month is required.' });
        }

        const emp = await EmployeeBasic.findOne({ employeeId }).select('employeeId').lean();
        const code = String(emp?.employeeId || employeeId).trim();
        const gate = await loadSalarySlipEnrollment(code);
        if (!salarySlipMonthAllowed(monthKey, gate)) {
            return res.status(400).json({ message: slipMonthDeniedMessage(gate.enrolled, gate.fromMonth) });
        }
        const live = await buildSalarySlipPayload({ employeeId: code, monthKey, skipOverride: true });
        const next = applySalarySlipOverride(live, req.body?.slip || {});
        const savedSlip = serializeSalarySlipForClient(next);

        const rawUser = req.user?.id || req.user?._id;
        const updatedBy =
            rawUser && mongoose.Types.ObjectId.isValid(rawUser) ? rawUser : null;

        await SalarySlipMonth.findOneAndUpdate(
            { employeeId: code, monthKey },
            { employeeId: code, monthKey, slip: savedSlip, updatedBy },
            { upsert: true, new: true, setDefaultsOnInsert: true },
        );

        const { applySalarySlipLeaveTicketPaymentsForEmployee, salaryMonthProcessedForEmployee } =
            await import('../../utils/applySalarySlipLeaveTicketPayments.js');
        if (await salaryMonthProcessedForEmployee(code, monthKey)) {
            await applySalarySlipLeaveTicketPaymentsForEmployee(code, monthKey, { slip: next });
        }

        return res.json({
            message: 'Salary slip updated.',
            slip: savedSlip,
            summary: summarizeSalarySlipListRow(next),
        });
    } catch (error) {
        const status = error instanceof SalarySlipError ? error.statusCode : 500;
        console.error('[saveSalarySlipMonth]', error?.message || error);
        return res.status(status).json({
            message: error.message || 'Failed to update salary slip.',
        });
    }
}
