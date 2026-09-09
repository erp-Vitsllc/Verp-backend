/**
 * Leave salary / air ticket remaining on a salary slip, and posting those
 * amounts as historical payment-cycle rows once the month is processed.
 */

import {
    cycleIncludesLeavePayment,
    cycleIncludesTicketPayment,
    roundMoney,
} from './salaryHistoricalCalculations.js';

export const SALARY_SLIP_REF_PREFIX = 'salary-slip:';

export function salarySlipPaymentRef(monthKey) {
    return `${SALARY_SLIP_REF_PREFIX}${String(monthKey || '').trim()}`;
}

export function isSalarySlipCycle(cycle, monthKey = '') {
    const ym = String(monthKey || '').trim();
    const slipMonth = String(cycle?.salarySlipMonthKey || '').trim();
    if (ym && slipMonth) return slipMonth === ym;
    const ref = String(cycle?.paymentReference || '').trim();
    if (ym) return ref === salarySlipPaymentRef(ym);
    return Boolean(slipMonth) || ref.startsWith(SALARY_SLIP_REF_PREFIX);
}

export function monthEndDateKey(ym) {
    const match = String(ym || '').match(/^(\d{4})-(\d{2})$/);
    if (!match) return '';
    const year = Number(match[1]);
    const month = Number(match[2]);
    const last = new Date(year, month, 0).getDate();
    return `${match[1]}-${match[2]}-${String(last).padStart(2, '0')}`;
}

export function isActivePaymentCycle(cycle) {
    const status = String(cycle?.paymentStatus || cycle?.status || '').trim().toLowerCase();
    return status !== 'cancelled' && status !== 'rejected' && status !== 'draft';
}

export function cycleLeaveAmount(cycle) {
    if (!cycleIncludesLeavePayment(cycle)) return 0;
    return roundMoney(cycle?.leaveSalaryAmount ?? cycle?.leaveSalary);
}

export function cycleTicketAmount(cycle) {
    if (!cycleIncludesTicketPayment(cycle)) return 0;
    return roundMoney(cycle?.ticketAmount);
}

export function paidLeaveTicketTotals(cycles) {
    let leave = 0;
    let ticket = 0;
    for (const cycle of Array.isArray(cycles) ? cycles : []) {
        if (!isActivePaymentCycle(cycle)) continue;
        leave = roundMoney(leave + cycleLeaveAmount(cycle));
        ticket = roundMoney(ticket + cycleTicketAmount(cycle));
    }
    return { leave, ticket };
}

export function remainingLeaveTicketBalances(entitlement, cycles) {
    const paid = paidLeaveTicketTotals(cycles);
    const leaveDue = roundMoney(entitlement?.totalLeaveSalary);
    const ticketDue = roundMoney(entitlement?.totalTicketAmount);
    return {
        leaveRemaining: roundMoney(Math.max(0, leaveDue - paid.leave)),
        ticketRemaining: roundMoney(Math.max(0, ticketDue - paid.ticket)),
        leavePaid: paid.leave,
        ticketPaid: paid.ticket,
        leaveDue,
        ticketDue,
    };
}

function entitlementKindDate(row) {
    return String(row?.entitlementDate || '').trim();
}

function cycleKindDate(cycle, kind) {
    if (kind === 'ticket') {
        return String(cycle?.ticketPaymentDate || cycle?.entitlementDate || '').trim();
    }
    return String(cycle?.leaveSalaryPaymentDate || cycle?.entitlementDate || '').trim();
}

export function cyclePaymentMatchesEntitlement(cycle, row, kind) {
    if (!cycle || !row) return false;
    const date = entitlementKindDate(row);
    const paymentDate = cycleKindDate(cycle, kind);
    if (date && paymentDate && paymentDate === date) return true;
    const entitlementNo = Number(row.entitlementNo);
    if (entitlementNo > 0 && Number(cycle.entitlementNo) === entitlementNo) return true;
    return false;
}

export function unpaidKindAmount(row, cycles, kind) {
    const due = roundMoney(kind === 'ticket' ? row?.ticketAmount : row?.leaveSalary);
    if (due <= 0) return 0;
    let paid = 0;
    for (const cycle of Array.isArray(cycles) ? cycles : []) {
        if (!isActivePaymentCycle(cycle)) continue;
        const amount = kind === 'ticket' ? cycleTicketAmount(cycle) : cycleLeaveAmount(cycle);
        if (amount <= 0) continue;
        if (!cyclePaymentMatchesEntitlement(cycle, row, kind)) continue;
        paid = roundMoney(paid + amount);
    }
    return roundMoney(Math.max(0, due - paid));
}

export function allocateAmountAcrossEntitlements(entitlements, cycles, kind, amount) {
    let left = roundMoney(Math.max(0, amount));
    const parts = [];
    for (const row of Array.isArray(entitlements) ? entitlements : []) {
        if (left <= 0) break;
        const unpaid = unpaidKindAmount(row, cycles, kind);
        if (unpaid <= 0) continue;
        const take = roundMoney(Math.min(unpaid, left));
        if (take <= 0) continue;
        parts.push({
            entitlementNo: Number(row.entitlementNo) || parts.length + 1,
            entitlementDate: entitlementKindDate(row),
            eligibilityStartDate: String(row.eligibilityStartDate || ''),
            eligibilityEndDate: String(row.eligibilityEndDate || ''),
            amount: take,
        });
        left = roundMoney(left - take);
    }
    return { parts, leftover: left };
}

function nextCycleNumber(cycles) {
    let max = 0;
    for (const cycle of Array.isArray(cycles) ? cycles : []) {
        const n = Number(cycle?.cycleNumber) || 0;
        if (n > max) max = n;
    }
    return max + 1;
}

export function readSlipLeaveTicketAmounts(slip) {
    const yearly = Array.isArray(slip?.yearlyEarnings) ? slip.yearlyEarnings : [];
    const monthly = Array.isArray(slip?.earnings) ? slip.earnings : [];
    const amountOf = (rows, names) => {
        const want = names.map((name) => String(name).toLowerCase());
        const row = rows.find((item) => want.includes(String(item?.component || '').trim().toLowerCase()));
        return roundMoney(row?.amount);
    };
    const leave =
        amountOf(yearly, ['Leave Salary']) ||
        amountOf(monthly, ['Leave Salary']);
    const ticket =
        amountOf(yearly, ['Travel Allowance', 'Ticket']) ||
        amountOf(monthly, ['Ticket', 'Travel Allowance']);
    return { leave, ticket };
}

export function syncSalarySlipPaymentCycles({
    cycles = [],
    entitlements = [],
    leaveAmount = 0,
    ticketAmount = 0,
    monthKey = '',
    paymentDate = '',
    remarks = '',
} = {}) {
    const ym = String(monthKey || '').trim();
    const others = (Array.isArray(cycles) ? cycles : []).filter((cycle) => !isSalarySlipCycle(cycle, ym));
    const leavePay = roundMoney(Math.max(0, leaveAmount));
    const ticketPay = roundMoney(Math.max(0, ticketAmount));
    if (leavePay <= 0 && ticketPay <= 0) return others;

    const leaveAlloc = allocateAmountAcrossEntitlements(entitlements, others, 'leave', leavePay);
    const ticketAlloc = allocateAmountAcrossEntitlements(entitlements, others, 'ticket', ticketPay);
    const byKey = new Map();
    const rowKey = (part) =>
        String(part.entitlementDate || '') || `no:${part.entitlementNo || ''}`;

    for (const part of leaveAlloc.parts) {
        byKey.set(rowKey(part), { ...part, leaveAmount: part.amount, ticketAmount: 0 });
    }
    for (const part of ticketAlloc.parts) {
        const key = rowKey(part);
        const existing = byKey.get(key);
        if (existing) {
            existing.ticketAmount = part.amount;
            continue;
        }
        byKey.set(key, { ...part, leaveAmount: 0, ticketAmount: part.amount });
    }

    const payDate = String(paymentDate || monthEndDateKey(ym) || '').trim();
    const note = String(remarks || '').trim() || `Paid on salary slip ${ym}`;
    let cycleNumber = nextCycleNumber(others);
    const created = [];
    for (const row of byKey.values()) {
        const leave = roundMoney(row.leaveAmount);
        const ticket = roundMoney(row.ticketAmount);
        if (leave <= 0 && ticket <= 0) continue;
        created.push({
            cycleNumber: cycleNumber,
            eligibilityStartDate: row.eligibilityStartDate || '',
            eligibilityEndDate: row.eligibilityEndDate || '',
            entitlementDays: 0,
            qualifyingDays: 0,
            leaveSalaryPaymentDate: leave > 0 ? row.entitlementDate : '',
            leaveSalaryAmount: leave,
            leaveSalary: leave,
            ticketPaymentDate: ticket > 0 ? row.entitlementDate : '',
            ticketAmount: ticket,
            paymentDate: payDate,
            currency: 'AED',
            paymentReference: salarySlipPaymentRef(ym),
            salarySlipMonthKey: ym,
            source: 'salarySlip',
            paymentStatus: 'paid',
            verificationStatus: 'verified',
            status: 'paid',
            remarks: note,
            includeLeave: leave > 0,
            includeTicket: ticket > 0,
            reduceHistoricalWorkingDays: false,
            entitlementDate: row.entitlementDate || '',
            entitlementNo: Number(row.entitlementNo) || 0,
        });
        cycleNumber += 1;
    }
    return [...others, ...created];
}

export function thisMonthLeaveTicketFromCycles(cycles, monthKey) {
    let leave = 0;
    let ticket = 0;
    let count = 0;
    for (const cycle of Array.isArray(cycles) ? cycles : []) {
        if (!isActivePaymentCycle(cycle)) continue;
        if (!isSalarySlipCycle(cycle, monthKey)) continue;
        const leaveAmt = cycleLeaveAmount(cycle);
        const ticketAmt = cycleTicketAmount(cycle);
        if (leaveAmt <= 0 && ticketAmt <= 0) continue;
        leave = roundMoney(leave + leaveAmt);
        ticket = roundMoney(ticket + ticketAmt);
        count += 1;
    }
    return { leave, ticket, count };
}
