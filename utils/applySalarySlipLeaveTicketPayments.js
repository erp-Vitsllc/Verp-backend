import EmployeeBasic from '../models/EmployeeBasic.js';
import EmployeeSalary from '../models/EmployeeSalary.js';
import SalaryHistoricalProfile from '../models/SalaryHistoricalProfile.js';
import SalaryMonthPayment from '../models/SalaryMonthPayment.js';
import SalarySlipMonth from '../models/SalarySlipMonth.js';
import { isCompanyShellEmployee } from './attendanceEmployeeFilters.js';
import {
    applySalarySlipOverride,
    buildSalarySlipPayload,
    monthKeyOf,
} from './buildSalarySlipPayload.js';
import { resolveEmployeePayrollPolicy } from './employeeLeavePolicy.js';
import { clearLeaveTicketEntitlementCache, loadLeaveTicketEntitlement } from './loadLeaveTicketEntitlement.js';
import {
    monthEndDateKey,
    readSlipLeaveTicketAmounts,
    remainingLeaveTicketBalances,
    syncSalarySlipPaymentCycles,
} from './salarySlipLeaveTicket.js';

function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function employeeCodeKey(value) {
    return String(value || '').trim();
}

export async function salaryMonthProcessedForEmployee(employeeId, monthKey) {
    const code = employeeCodeKey(employeeId);
    const ym = monthKeyOf(monthKey);
    if (!code || !ym) return false;
    const payments = await SalaryMonthPayment.find({ monthKey: ym }).select('employeeIds').lean();
    const needle = code.toLowerCase();
    return (payments || []).some((row) =>
        (row.employeeIds || []).some((id) => String(id || '').trim().toLowerCase() === needle),
    );
}

function monthLabel(ym) {
    const match = String(ym || '').match(/^(\d{4})-(\d{2})$/);
    if (!match) return ym;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, 1);
    return date.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

function cyclesFingerprint(cycles) {
    return JSON.stringify(
        (Array.isArray(cycles) ? cycles : []).map((row) => ({
            ref: row?.paymentReference,
            month: row?.salarySlipMonthKey,
            leave: row?.leaveSalaryAmount,
            ticket: row?.ticketAmount,
            status: row?.paymentStatus,
            leaveDate: row?.leaveSalaryPaymentDate,
            ticketDate: row?.ticketPaymentDate,
        })),
    );
}

/**
 * When a salary month is processed (or the slip is saved after that),
 * post the slip's leave salary / ticket amounts as paid historical rows.
 */
export async function applySalarySlipLeaveTicketPayments({
    employee,
    profile,
    salaryDoc,
    policy,
    monthKey,
    slip,
} = {}) {
    const ym = monthKeyOf(monthKey);
    const code = employeeCodeKey(employee?.employeeId || profile?.employeeId);
    if (!ym || !code || !profile) return { posted: false, cycles: profile?.paymentCycles || [] };

    let effectiveSlip = slip;
    if (!effectiveSlip) {
        const stored = await SalarySlipMonth.findOne({ employeeId: code, monthKey: ym }).select('slip').lean();
        const live = await buildSalarySlipPayload({
            employeeId: code,
            monthKey: ym,
            skipOverride: true,
            preloadedSalary: salaryDoc,
        });
        effectiveSlip = stored?.slip ? applySalarySlipOverride(live, stored.slip) : live;
    }

    const amounts = readSlipLeaveTicketAmounts(effectiveSlip);
    const state = await loadLeaveTicketEntitlement({
        employee,
        profile,
        salaryDoc,
        policy,
    });
    const remaining = remainingLeaveTicketBalances(
        state.entitlements,
        (state.cycles || []).filter((cycle) => {
            const slipMonth = String(cycle?.salarySlipMonthKey || '').trim();
            const ref = String(cycle?.paymentReference || '').trim();
            return slipMonth !== ym && ref !== `salary-slip:${ym}`;
        }),
    );
    const leaveAmount =
        remaining.leaveDue > 0 ? Math.min(amounts.leave, remaining.leaveRemaining) : amounts.leave;
    const ticketAmount =
        remaining.ticketDue > 0 ? Math.min(amounts.ticket, remaining.ticketRemaining) : amounts.ticket;
    const nextCycles = syncSalarySlipPaymentCycles({
        cycles: state.cycles,
        entitlements: state.entitlements?.entitlements,
        leaveAmount,
        ticketAmount,
        monthKey: ym,
        paymentDate: monthEndDateKey(ym),
        remarks: `Paid on salary slip ${monthLabel(ym)}`,
    });

    if (cyclesFingerprint(profile.paymentCycles) === cyclesFingerprint(nextCycles)) {
        return { posted: false, cycles: profile.paymentCycles || [] };
    }

    const idPattern = new RegExp(`^${escapeRegex(code)}$`, 'i');
    const doc = await SalaryHistoricalProfile.findOne({ employeeId: idPattern }).select('_id paymentCycles');
    if (!doc) return { posted: false, cycles: nextCycles };
    doc.paymentCycles = nextCycles;
    doc.markModified('paymentCycles');
    await doc.save();
    clearLeaveTicketEntitlementCache(code);
    return { posted: true, cycles: nextCycles };
}

export async function applySalarySlipLeaveTicketPaymentsForEmployee(employeeId, monthKey, { slip } = {}) {
    const code = employeeCodeKey(employeeId);
    const ym = monthKeyOf(monthKey);
    if (!code || !ym) return { posted: false };
    const idPattern = new RegExp(`^${escapeRegex(code)}$`, 'i');
    const emp = await EmployeeBasic.findOne({ employeeId: idPattern }).lean();
    if (!emp || isCompanyShellEmployee(emp)) return { posted: false };
    const [profile, salaryDoc, policy] = await Promise.all([
        SalaryHistoricalProfile.findOne({ employeeId: idPattern }).lean(),
        EmployeeSalary.findOne({ employeeId: idPattern })
            .select('-offerLetter.data -salaryHistory.attachment.data -salaryHistory.offerLetter.data')
            .lean(),
        resolveEmployeePayrollPolicy(emp),
    ]);
    if (!profile) return { posted: false };
    return applySalarySlipLeaveTicketPayments({
        employee: emp,
        profile,
        salaryDoc,
        policy,
        monthKey: ym,
        slip,
    });
}
