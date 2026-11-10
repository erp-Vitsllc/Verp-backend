import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSalarySlipPdfHtml } from './buildSalarySlipPdfHtml.js';
import {
    amountInWordsAed,
    attendanceDayHasPunch,
    mergeStoredSalarySlip,
    monthKeyOf,
    salarySlipPayrollFigures,
    unpaidDueByMonth,
    unpaidSchedulePortion,
    dueThroughSalaryMonth,
    currentMonthInstallment,
    currentMonthShare,
    recoveryCurrentMonthShare,
    recoveryDueThroughSalaryMonth,
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
        assert.equal(figures.ot, 9.68);
        assert.equal(figures.extra, 9.68);
        assert.equal(figures.fine, 0);
        assert.equal(figures.loan, 0);
        assert.equal(figures.deduction, 10);
        assert.equal(figures.lossOfPay, 10);
        assert.equal(figures.otherDeduction, 0);
        assert.equal(figures.netSalary, 1590);
        assert.equal(figures.zohoSalary, 1499.68);
        assert.equal(figures.grossSalary, figures.zohoSalary);
        assert.equal(figures.netSalaryPayable, 1499.68);
        assert.equal(figures.actualSalary, figures.netSalaryPayable);
        assert.equal(
            Math.round((figures.monthlySalary + figures.extra - figures.deduction) * 100) / 100,
            figures.netSalaryPayable,
        );
    });

    it('keeps live amounts when the slip was not edited', () => {
        const live = sampleSlip();
        const stored = sampleSlip();
        const figures = salarySlipPayrollFigures(mergeStoredSalarySlip(live, stored));
        assert.equal(figures.extra, 59.68);
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
        assert.equal(figures.ot, 9.68);
        assert.equal(figures.rewardAdditions, 50);
        assert.equal(figures.grossSalary, 1511.68);
        assert.equal(figures.zohoSalary, figures.grossSalary);
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

    it('keeps a saved late out line in payroll loss of pay under Early Out', () => {
        const figures = salarySlipPayrollFigures(sampleSlip({
            deductions: [
                { component: 'Late out', basis: '2 events', amount: 25 },
                { component: 'Fine', basis: 'Installment', amount: 20 },
                { component: 'Loan', basis: 'Monthly', amount: 30 },
            ],
        }));
        assert.equal(figures.lossOfPay, 25);
        assert.equal(figures.sheetLossOfPay, 25);
    });

    it('includes each suspended day in payroll loss of pay', () => {
        const figures = salarySlipPayrollFigures(sampleSlip({
            deductions: [
                { component: 'Authorized Leave', basis: '1 day', amount: 48 },
                { component: 'Suspended', basis: '3 days', amount: 150 },
                { component: 'Fine', basis: 'Installment', amount: 20 },
                { component: 'Loan', basis: 'Monthly', amount: 30 },
            ],
        }));
        assert.equal(figures.lossOfPay, 198);
        assert.equal(figures.sheetLossOfPay, 198);
        assert.equal(figures.zohoSalary, 1361.68);
        assert.equal(figures.netSalaryPayable, 1311.68);
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
        assert.equal(figures.lossOfPay, 65);
        assert.equal(figures.sheetLossOfPay, 65);
        assert.equal(figures.deduction, 115);
        assert.equal(figures.zohoSalary, 1494.68);
        assert.equal(figures.netSalaryPayable, 1444.68);
        assert.equal(figures.actualSalary, figures.netSalaryPayable);
        assert.equal(figures.grossSalary, figures.zohoSalary);
    });

    it('uses the salary slip net salary payable, including every loan this month', () => {
        const slip = sampleSlip({
            summary: {
                monthlySalary: 1500,
                overtimeHoursCount: 2,
                leaveSalary: { amount: 200 },
                airTicket: { amount: 50 },
                lossOfPayDays: { annual: 0 },
            },
            deductions: [
                { component: 'Authorized Leave', basis: '1 day', amount: 48 },
                { component: 'Annual Leave', basis: '2 days', amount: 80 },
                { component: 'Sick Leave', basis: '1 day', amount: 7 },
                { component: 'Fine', basis: 'Installment', amount: 20 },
                { component: 'Loan', basis: 'Monthly', amount: 30 },
            ],
            loanSchedule: [
                { type: 'Loan', sourceId: 'loan-1', thisMonthAmount: 30 },
                { type: 'Loan', sourceId: 'loan-2', thisMonthAmount: 40 },
            ],
            fines: [{ sourceId: 'fine-1', thisMonthAmount: 20 }],
            utilities: [{ sourceId: 'util-1', thisMonthAmount: 15 }],
            yearlyEarnings: [{ component: 'Leave Salary', basis: 'Yearly', amount: 999 }],
        });
        const merged = mergeStoredSalarySlip(slip, slip);
        const loanLine = merged.deductions.find((row) => row.component === 'Loan');
        assert.equal(loanLine.amount, 70);
        const figures = salarySlipPayrollFigures(slip);
        assert.equal(figures.lossOfPay, 48);
        assert.equal(figures.loanAmount, 70);
        assert.equal(figures.fineAmount, 20);
        assert.equal(figures.sheetOtherDeduction, 15);
        assert.equal(figures.otherDeduction, 105);
        assert.equal(figures.zohoSalary, 1761.68);
        assert.equal(figures.netSalaryPayable, 1656.68);
        assert.equal(figures.actualSalary, figures.netSalaryPayable);
        assert.equal(figures.grossSalary, figures.zohoSalary);
        assert.equal(figures.extra, 309.68);
        assert.equal(figures.deduction, 153);
    });

    it('adds a manual other deduction under utility without changing zoho salary', () => {
        const withUtility = {
            deductions: [
                { component: 'Authorized Leave', basis: '1 day', amount: 48 },
                { component: 'Fine', basis: 'Installment', amount: 20 },
                { component: 'Loan', basis: 'Monthly', amount: 30 },
                { component: 'Utility Excess', basis: 'SIM cards', amount: 15 },
            ],
            utilities: [{ sourceId: 'util-1', thisMonthAmount: 15 }],
        };
        const plain = mergeStoredSalarySlip(sampleSlip(withUtility), sampleSlip(withUtility));
        const withOther = mergeStoredSalarySlip(
            sampleSlip(withUtility),
            sampleSlip({
                ...withUtility,
                manualOtherDeduction: { description: '  Uniform  ', amount: 25.5 },
            }),
        );
        const plainPay = salarySlipPayrollFigures(plain);
        const otherPay = salarySlipPayrollFigures(withOther);
        assert.equal(otherPay.zohoSalary, plainPay.zohoSalary);
        assert.equal(otherPay.grossSalary, otherPay.zohoSalary);
        assert.equal(otherPay.lossOfPay, plainPay.lossOfPay);
        assert.equal(otherPay.fineAmount, plainPay.fineAmount);
        assert.equal(otherPay.loanAmount, plainPay.loanAmount);
        assert.equal(Math.round((plainPay.netSalaryPayable - otherPay.netSalaryPayable) * 100) / 100, 25.5);
        assert.equal(Math.round((otherPay.deduction - plainPay.deduction) * 100) / 100, 25.5);
        assert.equal(Math.round((otherPay.sheetOtherDeduction - plainPay.sheetOtherDeduction) * 100) / 100, 25.5);
        const names = withOther.deductions.map((row) => row.component);
        const utilityIndex = names.indexOf('Utility Excess');
        assert.equal(names[utilityIndex + 1], 'Other deduction');
        const line = withOther.deductions[utilityIndex + 1];
        assert.equal(line.amount, 25.5);
        assert.equal(line.basis, 'Uniform');
        const html = buildSalarySlipPdfHtml(withOther);
        const pdfMoney = (value) => Number(value).toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        });
        const zohoText = pdfMoney(otherPay.zohoSalary);
        const deductedFromGross = Math.round((otherPay.zohoSalary - withOther.netSalary) * 100) / 100;
        assert.match(html, /GROSS SALARY/);
        assert.match(html, new RegExp(`AED ${zohoText.replace('.', '\\.')}`));
        assert.match(html, new RegExp(`AED ${pdfMoney(deductedFromGross).replace('.', '\\.')}`));
        assert.match(html, new RegExp(`AED ${pdfMoney(withOther.netSalary).replace('.', '\\.')}`));
        assert.match(html, /Other deduction/);
        assert.match(html, /Uniform/);
        const plainHtml = buildSalarySlipPdfHtml(plain);
        assert.equal(plainHtml.includes('Other deduction'), false);
        assert.match(plainHtml, /GROSS SALARY/);
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

    it('keeps this month share separate from the full outstanding balance', () => {
        const party = {
            status: 'Partially Paid',
            amount: 3500,
            installments: [
                { monthKey: '2026-09', amount: 875, status: 'Not Paid' },
                { monthKey: '2026-10', amount: 875, status: 'Not Paid' },
                { monthKey: '2026-11', amount: 875, status: 'Partially Paid' },
                { monthKey: '2026-12', amount: 875, status: 'Not Paid' },
            ],
        };
        assert.equal(
            currentMonthShare(party, {
                total: 3500,
                repaid: 0,
                startYm: '2026-09',
                duration: 4,
                ym: '2026-10',
            }),
            875,
        );
        assert.equal(
            currentMonthInstallment({
                total: 3500,
                repaid: 875,
                startYm: '2026-09',
                duration: 4,
                ym: '2026-10',
            }),
            875,
        );
        assert.equal(
            currentMonthInstallment({
                total: 3500,
                repaid: 1000,
                startYm: '2026-09',
                duration: 4,
                ym: '2026-10',
            }),
            750,
        );
        assert.equal(
            recoveryCurrentMonthShare({
                total: 3500,
                repaid: 0,
                startYm: '2026-09',
                duration: 4,
                ym: '2026-10',
                party: {
                    status: 'Paid',
                    amount: 3500,
                    installments: party.installments.map((row) => ({ ...row, status: 'Paid' })),
                },
            }),
            875,
        );
    });

    it('still shows an unrepaid loan after company disbursement marked the schedule paid', () => {
        const party = {
            status: 'Paid',
            amount: 3500,
            installments: [
                { monthKey: '2026-09', amount: 875, status: 'Paid' },
                { monthKey: '2026-10', amount: 875, status: 'Paid' },
                { monthKey: '2026-11', amount: 875, status: 'Paid' },
                { monthKey: '2026-12', amount: 875, status: 'Paid' },
            ],
        };
        assert.equal(
            recoveryDueThroughSalaryMonth({
                total: 3500,
                repaid: 0,
                startYm: '2026-09',
                duration: 4,
                ym: '2026-10',
                party,
            }),
            1750,
        );
        assert.equal(
            recoveryDueThroughSalaryMonth({
                total: 3500,
                repaid: 875,
                startYm: '2026-09',
                duration: 4,
                ym: '2026-10',
                party: {
                    ...party,
                    status: 'Not Paid',
                    installments: party.installments.map((row) =>
                        row.monthKey === '2026-09' ? row : { ...row, status: 'Not Paid' },
                    ),
                },
            }),
            875,
        );
        assert.equal(
            recoveryDueThroughSalaryMonth({
                total: 3500,
                repaid: 3500,
                startYm: '2026-09',
                duration: 4,
                ym: '2026-10',
                party,
            }),
            0,
        );
    });
});
