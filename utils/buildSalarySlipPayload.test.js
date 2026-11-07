import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    amountInWordsAed,
    attendanceDayHasPunch,
    mergeStoredSalarySlip,
    monthKeyOf,
    salarySlipPayrollFigures,
    unpaidDueByMonth,
    unpaidSchedulePortion,
    dueThroughSalaryMonth,
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

    it('splits payroll sheet columns from the slip', () => {
        const slip = mergeStoredSalarySlip(
            sampleSlip({ attendance: { presentDays: '22 days' } }),
            sampleSlip({ attendance: { presentDays: '22 days' } }),
        );
        const figures = salarySlipPayrollFigures(slip);
        assert.equal(figures.basicSalary, 750);
        assert.equal(figures.otherAllowance, 750);
        assert.equal(figures.monthlySalary, 1500);
        assert.equal(figures.presentDays, 22);
        assert.equal(figures.lossOfPay, 48);
        assert.equal(figures.ot, 100);
        assert.equal(figures.rewardAdditions, 50);
        assert.equal(figures.grossSalary, 1650);
        assert.equal(figures.fineAmount, 20);
        assert.equal(figures.advanceAmount, 0);
        assert.equal(figures.loanAmount, 30);
        assert.equal(figures.sheetOtherDeduction, 0);
        assert.equal(figures.netSalary, 1552);
        assert.equal(figures.sheetPresentDays, 22);
        assert.equal(figures.sheetLossOfPay, 48);
    });

    it('counts a present day from a time in, a time out, or both', () => {
        assert.equal(attendanceDayHasPunch({ statusKey: 'mispunch', timeIn: '09:12' }), true);
        assert.equal(attendanceDayHasPunch({ statusKey: 'early_go', timeOut: '16:40' }), true);
        assert.equal(attendanceDayHasPunch({ statusKey: 'on_office', timeIn: '09:00', timeOut: '18:00' }), true);
        assert.equal(attendanceDayHasPunch({ statusKey: 'late_arrived', timeIn: '09:40', timeOut: '18:05' }), true);
        assert.equal(attendanceDayHasPunch({ timeIn: '  ', timeOut: '' }), false);
        assert.equal(attendanceDayHasPunch({ statusKey: 'on_office' }), false);
        assert.equal(attendanceDayHasPunch({ punchSessions: [{ timeOut: '13:00' }] }), true);
    });

    it('keeps the payroll sheet loss of pay to the slip total, and gross to zoho salary', () => {
        const figures = salarySlipPayrollFigures(sampleSlip({
            attendance: { presentDays: '22 days', punchedPresentDays: 26 },
            deductions: [
                { component: 'Authorized Leave', basis: '1 day', amount: 48 },
                { component: 'Late in', basis: '1 event', amount: 12 },
                { component: 'Sick Leave', basis: '1 day', amount: 7 },
                { component: 'Missed Punch', basis: '1 day', amount: 5 },
                { component: 'Fine', basis: 'Installment', amount: 20 },
                { component: 'Loan', basis: 'Monthly', amount: 30 },
            ],
        }));
        assert.equal(figures.presentDays, 22);
        assert.equal(figures.sheetPresentDays, 26);
        assert.equal(figures.lossOfPay, 72);
        assert.equal(figures.sheetLossOfPay, 60);
        assert.equal(figures.zohoSalary, 1590);
        assert.equal(figures.actualSalary, 1540);
        assert.equal(figures.grossSalary, 1650);
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

    it('sums only unpaid months on or before the salary month', () => {
        const party = {
            status: 'Not Paid',
            amount: 3500,
            installments: [
                { monthKey: '2026-09', amount: 875, status: 'Not Paid' },
                { monthKey: '2026-10', amount: 875, status: 'Not Paid' },
                { monthKey: '2026-11', amount: 875, status: 'Not Paid' },
                { monthKey: '2026-12', amount: 875, status: 'Not Paid' },
            ],
        };
        assert.equal(
            dueThroughSalaryMonth(party, {
                total: 3500,
                repaid: 0,
                startYm: '2026-09',
                duration: 4,
                ym: '2026-10',
            }),
            1750,
        );
        assert.equal(
            dueThroughSalaryMonth(
                {
                    ...party,
                    installments: party.installments.map((row) =>
                        row.monthKey === '2026-09' ? { ...row, status: 'Paid' } : row,
                    ),
                },
                {
                    total: 3500,
                    repaid: 875,
                    startYm: '2026-09',
                    duration: 4,
                    ym: '2026-10',
                },
            ),
            875,
        );
        assert.equal(
            unpaidSchedulePortion({
                total: 3500,
                repaid: 0,
                startYm: '2026-09',
                duration: 4,
                ym: '2026-10',
            }),
            1750,
        );
        assert.equal(
            dueThroughSalaryMonth(null, {
                total: 900,
                repaid: 0,
                startYm: '2026-09',
                duration: 3,
                ym: '2026-10',
            }),
            600,
        );
        assert.equal(
            dueThroughSalaryMonth(
                { status: 'Not Paid', amount: 3500, monthStart: '2026-09', installments: [] },
                {
                    total: 3500,
                    repaid: 0,
                    startYm: '2026-09',
                    duration: 4,
                    ym: '2026-10',
                },
            ),
            1750,
        );
    });
});
