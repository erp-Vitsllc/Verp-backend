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
import { getScheduledEmailTimeZone, getZonedParts } from '../../utils/scheduleDailyAtMidnight.js';

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

function pad2(n) {
    return String(n).padStart(2, '0');
}

function addMonthsYm(ym, delta) {
    const match = String(ym || '').match(/^(\d{4})-(\d{2})$/);
    if (!match) return '';
    const date = new Date(Number(match[1]), Number(match[2]) - 1 + delta, 1);
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

function listMonthsInclusive(fromYm, toYm) {
    const months = [];
    let cursor = fromYm;
    while (cursor && cursor <= toYm) {
        months.push(cursor);
        const next = addMonthsYm(cursor, 1);
        if (!next || next === cursor) break;
        cursor = next;
    }
    return months;
}

/** Latest salary-processing month. That month's row opens on the 1st. */
function currentSalaryMonthKey(now = new Date()) {
    const dubai = getZonedParts(now, getScheduledEmailTimeZone());
    return `${dubai.year}-${pad2(dubai.month)}`;
}

function laterMonth(a, b) {
    if (!a) return b || '';
    if (!b) return a;
    return a >= b ? a : b;
}

/**
 * GET /api/Employee/salary-enroll/:employeeId/historical/salary-slips
 * Months from this employee's salary start through the current processing month.
 * Each month appears on its 1st, so the current month shows from 1 Sep onward.
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

        const currentYm = currentSalaryMonthKey();
        const policyStartYm = monthKeyOf(payrollDoc?.salaryProcessStartMonth);
        const employeeStartYm = monthKeyOf(profile?.verpStartDate) || monthKeyOf(enrollment?.fromMonth);
        let fromYm = laterMonth(employeeStartYm, policyStartYm) || currentYm;
        if (fromYm > currentYm) fromYm = currentYm;
        const monthKeys = listMonthsInclusive(fromYm, currentYm).reverse();

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

        return res.json({ employeeId: code, months });
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
