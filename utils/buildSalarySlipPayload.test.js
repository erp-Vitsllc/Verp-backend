import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    amountInWordsAed,
    mergeStoredSalarySlip,
    monthKeyOf,
    salarySlipPayrollFigures,
    unpaidDueByMonth,
    unpaidSchedulePortion,
    yearlyEndOfServiceBenefit,
} from './buildSalarySlipPayload.js';

describe('salary slip wording', () => {
    it('matches the VEGA sample net-pay amount in words', () => {
        assert.equal(
            amountInWordsAed(10727.5),
            'Ten Thousand Seven Hundred Twenty-Seven Dirhams and Fifty Fils Only',
        );
    });

    it('parses salary month keys', () => {
        assert.equal(monthKeyOf('July 2026'), '2026-07');
        assert.equal(monthKeyOf('2026-07-31'), '2026-07');
        assert.equal(monthKeyOf('2026-07'), '2026-07');
    });
});

describe('employee end of service on the slip', () => {
    it('accrues 21 days of this employee basic, yearly', () => {
        assert.equal(yearlyEndOfServiceBenefit(95988, '2023-01-15', 2026), 67191.6);
        assert.equal(yearlyEndOfServiceBenefit(7999, '2023-01-15', 2026), 5599.23);
    });
});

function sampleSlip(overrides = {}) {
    return {
        monthKey: '2026-10',
        summary: { monthlySalary: 1500 },
        earnings: [
            { component: 'Basic Salary', basis: 'Monthly', amount: 750 },
            { component: 'Other Allowance', basis: 'Monthly', amount: 750 },
            { component: 'Overtime Hours', basis: '2 h', amount: 100 },
            { component: 'Reward', basis: 'Approved', amount: 50 },
        ],
        deductions: [
            { component: 'Authorized Leave', basis: '1 day', amount: 48 },
            { component: 'Fine', basis: 'Installment', amount: 20 },
            { component: 'Loan', basis: 'Monthly', amount: 30 },
        ],
        attendanceDeductions: [
            { category: 'Authorized Leave', total: 48 },
        ],
        loanSchedule: [
            { type: 'Loan', sourceId: 'loan-1', amount: 300, total: 300, thisMonthAmount: 30 },
        ],
        fines: [
            { sourceId: 'fine-1', amount: 20, total: 20, thisMonthAmount: 20 },
        ],
        utilities: [],
        thisMonthOverrides: {},
        ...overrides,
    };
}

describe('salary slip edits drive pay figures', () => {
    it('keeps a cleared addition, fine, and loan, and the net follows that slip', () => {
        const live = sampleSlip();
        const stored = sampleSlip({
            earnings: [
                { component: 'Basic Salary', basis: 'Monthly', amount: 750 },
                { component: 'Other Allowance', basis: 'Monthly', amount: 750 },
                { component: 'Overtime Hours', basis: '2 h', amount: 100 },
                { component: 'Reward', basis: 'Approved', amount: 0 },
            ],
            deductions: [
                { component: 'Authorized Leave', basis: '1 day', amount: 10 },
                { component: 'Fine', basis: 'Installment', amount: 0 },
                { component: 'Loan', basis: 'Monthly', amount: 0 },
            ],
            loanSchedule: [
                { type: 'Loan', sourceId: 'loan-1', amount: 300, total: 300, thisMonthAmount: 0 },
            ],
            fines: [
                { sourceId: 'fine-1', amount: 20, total: 20, thisMonthAmount: 0 },
            ],
            thisMonthOverrides: {
                Reward: true,
                'Authorized Leave': true,
                Fine: true,
                Loan: true,
            },
        });
        const merged = mergeStoredSalarySlip(live, stored);
        const figures = salarySlipPayrollFigures(merged);
        assert.equal(figures.monthlySalary, 1500);
        assert.equal(figures.ot, 100);
        assert.equal(figures.extra, 100);
        assert.equal(figures.fine, 0);
        assert.equal(figures.loan, 0);
        assert.equal(figures.deduction, 10);
        assert.equal(figures.lossOfPay, 10);
        assert.equal(figures.otherDeduction, 0);
        assert.equal(figures.netSalary, 1590);
        assert.equal(figures.actualSalary, figures.netSalary);
        assert.equal(
            Math.round((figures.monthlySalary + figures.extra - figures.deduction) * 100) / 100,
            figures.netSalary,
        );
    });

    it('keeps live amounts when the slip was not edited', () => {
        const live = sampleSlip();
        const stored = sampleSlip();
        const figures = salarySlipPayrollFigures(mergeStoredSalarySlip(live, stored));
        assert.equal(figures.extra, 150);
        assert.equal(figures.deduction, 98);
        assert.equal(figures.lossOfPay, 48);
        assert.equal(figures.otherDeduction, 50);
        assert.equal(figures.netSalary, 1552);
    });
});

describe('unpaid deduction carry-over', () => {
    it('adds an unpaid one-month fine to the next salary month', () => {
        assert.equal(
            unpaidSchedulePortion({
                total: 420,
                repaid: 0,
                startYm: '2026-08',
                duration: 1,
                ym: '2026-09',
            }),
            420,
        );
    });

    it('keeps the current installment plus unpaid prior months', () => {
        assert.equal(
            unpaidSchedulePortion({
                total: 300,
                repaid: 0,
                startYm: '2026-06',
                duration: 3,
                ym: '2026-08',
            }),
            300,
        );
        assert.equal(
            unpaidSchedulePortion({
                total: 300,
                repaid: 100,
                startYm: '2026-06',
                duration: 3,
                ym: '2026-08',
            }),
            200,
        );
    });

    it('does not deduct before the schedule starts', () => {
        assert.equal(
            unpaidSchedulePortion({
                total: 420,
                repaid: 0,
                startYm: '2026-08',
                duration: 1,
                ym: '2026-07',
            }),
            0,
        );
    });

    it('carries unpaid party installments into later months', () => {
        const exp = {
            status: 'Not Paid',
            amount: 420,
            installments: [{ monthKey: '2026-08', amount: 420, status: 'Not Paid' }],
        };
        assert.equal(unpaidDueByMonth(exp, '2026-08'), 420);
        assert.equal(unpaidDueByMonth(exp, '2026-09'), 420);
        assert.equal(
            unpaidDueByMonth(
                { ...exp, installments: [{ monthKey: '2026-08', amount: 420, status: 'Paid' }] },
                '2026-09',
            ),
            0,
        );
    });
});
