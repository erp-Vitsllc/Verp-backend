import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    allocateAmountAcrossEntitlements,
    isSalarySlipCycle,
    monthEndDateKey,
    readSlipLeaveTicketAmounts,
    remainingLeaveTicketBalances,
    salarySlipPaymentRef,
    syncSalarySlipPaymentCycles,
    unpaidKindAmount,
} from './salarySlipLeaveTicket.js';

const entitlements = [
    {
        entitlementNo: 1,
        entitlementDate: '2025-02-01',
        eligibilityStartDate: '2024-01-15',
        eligibilityEndDate: '2025-01-14',
        leaveSalary: 4000,
        ticketAmount: 1500,
    },
    {
        entitlementNo: 2,
        entitlementDate: '2026-03-01',
        eligibilityStartDate: '2025-01-15',
        eligibilityEndDate: '2026-01-14',
        leaveSalary: 4000,
        ticketAmount: 1500,
    },
];

describe('salary slip leave/ticket remaining', () => {
    it('builds a salary-slip payment reference for the month', () => {
        assert.equal(salarySlipPaymentRef('2026-08'), 'salary-slip:2026-08');
        assert.equal(monthEndDateKey('2026-08'), '2026-08-31');
        assert.equal(monthEndDateKey('2026-02'), '2026-02-28');
    });

    it('subtracts paid cycles from entitlement totals', () => {
        const remaining = remainingLeaveTicketBalances(
            { totalLeaveSalary: 8000, totalTicketAmount: 3000 },
            [
                { leaveSalaryAmount: 4000, includeLeave: true, paymentStatus: 'paid' },
                { ticketAmount: 1500, includeTicket: true, paymentStatus: 'paid' },
                { leaveSalaryAmount: 999, includeLeave: true, paymentStatus: 'draft' },
            ],
        );
        assert.equal(remaining.leaveRemaining, 4000);
        assert.equal(remaining.ticketRemaining, 1500);
    });

    it('treats a matching entitlement-date cycle as paid for that row', () => {
        const unpaid = unpaidKindAmount(
            entitlements[0],
            [
                {
                    leaveSalaryPaymentDate: '2025-02-01',
                    leaveSalaryAmount: 2500,
                    includeLeave: true,
                    paymentStatus: 'paid',
                },
            ],
            'leave',
        );
        assert.equal(unpaid, 1500);
    });
});

describe('salary slip leave/ticket posting', () => {
    it('fills unpaid entitlements in order until the slip amount is used', () => {
        const { parts, leftover } = allocateAmountAcrossEntitlements(
            entitlements,
            [],
            'leave',
            5000,
        );
        assert.equal(leftover, 0);
        assert.equal(parts.length, 2);
        assert.equal(parts[0].entitlementDate, '2025-02-01');
        assert.equal(parts[0].amount, 4000);
        assert.equal(parts[1].amount, 1000);
    });

    it('creates paid leave and ticket rows from salary-slip amounts', () => {
        const next = syncSalarySlipPaymentCycles({
            cycles: [{ cycleNumber: 1, leaveSalaryAmount: 200, includeLeave: true, paymentStatus: 'paid' }],
            entitlements,
            leaveAmount: 4000,
            ticketAmount: 1500,
            monthKey: '2026-08',
        });
        const posted = next.filter((row) => isSalarySlipCycle(row, '2026-08'));
        assert.equal(posted.length, 1);
        assert.equal(posted[0].leaveSalaryAmount, 4000);
        assert.equal(posted[0].ticketAmount, 1500);
        assert.equal(posted[0].leaveSalaryPaymentDate, '2025-02-01');
        assert.equal(posted[0].ticketPaymentDate, '2025-02-01');
        assert.equal(posted[0].paymentStatus, 'paid');
        assert.equal(posted[0].paymentReference, 'salary-slip:2026-08');
        assert.equal(next.length, 2);
    });

    it('replaces an earlier salary-slip posting for the same month', () => {
        const first = syncSalarySlipPaymentCycles({
            cycles: [],
            entitlements,
            leaveAmount: 8000,
            ticketAmount: 0,
            monthKey: '2026-08',
        });
        const second = syncSalarySlipPaymentCycles({
            cycles: first,
            entitlements,
            leaveAmount: 1000,
            ticketAmount: 0,
            monthKey: '2026-08',
        });
        const posted = second.filter((row) => isSalarySlipCycle(row, '2026-08'));
        assert.equal(posted.length, 1);
        assert.equal(posted[0].leaveSalaryAmount, 1000);
        assert.equal(second.length, 1);
    });

    it('reads leave salary and ticket amounts from the slip', () => {
        const amounts = readSlipLeaveTicketAmounts({
            yearlyEarnings: [
                { component: 'Leave Salary', amount: 2100 },
                { component: 'Travel Allowance', amount: 900 },
            ],
            earnings: [{ component: 'Leave Salary', amount: 0 }],
        });
        assert.equal(amounts.leave, 2100);
        assert.equal(amounts.ticket, 900);
    });
});
