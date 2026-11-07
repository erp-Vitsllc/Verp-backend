import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    employeePortionAmount,
    summarizeUtilityPortionSettlement,
    unpaidEmployeePortionOnSalaryMonth,
} from './utilityEmployeePortionStatus.js';

const employeeIds = ['VEGA-HR-0101', '507f1f77bcf86cd799439011'];

function bill(overrides = {}) {
    return {
        _id: 'bill-1',
        status: 'Approved',
        billMonth: '2026-09',
        amount: 700.82,
        companyPayAmount: 200,
        employeePayAmount: 500.82,
        payByEmployeeId: 'VEGA-HR-0101',
        zohoLineItems: [
            { payByEmployeeId: 'VEGA-HR-0101', amount: 274.16 },
            { payByEmployeeId: 'VEGA-HR-0999', amount: 226.66 },
        ],
        ...overrides,
    };
}

describe('employeePortionAmount', () => {
    it('uses this employee line share', () => {
        assert.equal(employeePortionAmount(bill(), employeeIds), 274.16);
    });

    it('falls back to the bill employee total when no line matches', () => {
        assert.equal(
            employeePortionAmount(
                bill({ zohoLineItems: [], payByEmployeeId: 'VEGA-HR-0101', employeePayAmount: 80 }),
                employeeIds,
            ),
            80,
        );
    });
});

describe('summarizeUtilityPortionSettlement', () => {
    it('still collects the unpaid employee portion after the vendor bill is paid', () => {
        const row = summarizeUtilityPortionSettlement({
            bill: bill({ status: 'Paid' }),
            employeeIds,
        });
        assert.equal(row.status, 'Not Paid');
        assert.equal(row.outstanding, 274.16);
        assert.equal(row.canPay, true);
        assert.equal(row.portion, 274.16);
    });

    it('hides pay when Zoho already has the expense', () => {
        const row = summarizeUtilityPortionSettlement({
            bill: bill(),
            employeeIds,
            zohoExpenseMatched: true,
        });
        assert.equal(row.status, 'Paid');
        assert.equal(row.canPay, false);
        assert.equal(row.via, 'zoho_expense');
    });

    it('marks paid when payroll Zoho covers the bill month', () => {
        const row = summarizeUtilityPortionSettlement({
            bill: bill(),
            employeeIds,
            payrollZohoMonths: ['2026-10'],
        });
        assert.equal(row.status, 'Paid');
        assert.equal(row.via, 'payroll');
        assert.equal(row.canPay, false);
    });

    it('keeps a later bill unpaid when payroll Zoho is only for an earlier month', () => {
        const row = summarizeUtilityPortionSettlement({
            bill: bill({ billMonth: '2026-11' }),
            employeeIds,
            payrollZohoMonths: ['2026-09'],
        });
        assert.equal(row.status, 'Not Paid');
        assert.equal(row.canPay, true);
        assert.equal(row.outstanding, 274.16);
    });

    it('marks Paid Employee when salary or cash covers the portion and Zoho is not used', () => {
        const row = summarizeUtilityPortionSettlement({
            bill: bill(),
            employeeIds,
            payments: [
                {
                    relatedEntityId: 'bill-1',
                    amount: 274.16,
                    status: 'Completed',
                    settleEmployeeId: 'VEGA-HR-0101',
                    zohoExpenseId: '',
                },
            ],
        });
        assert.equal(row.status, 'Paid Employee');
        assert.equal(row.outstanding, 0);
        assert.equal(row.canPay, false);
    });

    it('does not treat a company-share payment as the employee portion', () => {
        const row = summarizeUtilityPortionSettlement({
            bill: bill(),
            employeeIds,
            partyExpense: { status: 'Paid', paymentMode: '' },
            payments: [
                {
                    relatedEntityId: 'bill-1',
                    amount: 500,
                    status: 'Completed',
                    description: 'Zoho Payments Made · Company share',
                },
            ],
        });
        assert.equal(row.outstanding, 274.16);
        assert.equal(row.status, 'Not Paid');
        assert.equal(row.canPay, true);
    });

    it('keeps a partial employee payment open', () => {
        const row = summarizeUtilityPortionSettlement({
            bill: bill(),
            employeeIds,
            payments: [
                {
                    relatedEntityId: 'bill-1',
                    amount: 100,
                    status: 'Completed',
                    settleEmployeeId: 'VEGA-HR-0101',
                },
            ],
        });
        assert.equal(row.status, 'Not Paid');
        assert.equal(row.outstanding, 174.16);
        assert.equal(row.canPay, true);
    });

    it('does not offer pay before the bill is approved', () => {
        const row = summarizeUtilityPortionSettlement({
            bill: bill({ status: 'Pending Accounts' }),
            employeeIds,
        });
        assert.equal(row.status, 'Not Paid');
        assert.equal(row.canPay, false);
    });

    it('ignores a vendor employee-share payment when the employee has not paid', () => {
        const row = summarizeUtilityPortionSettlement({
            bill: bill({ status: 'Paid' }),
            employeeIds,
            partyExpense: { status: 'Paid', paymentMode: '' },
            payments: [
                {
                    relatedEntityId: 'bill-1',
                    amount: 500.82,
                    status: 'Completed',
                    description: 'Zoho Payments Made · Employee share (Name)',
                },
            ],
        });
        assert.equal(row.outstanding, 274.16);
        assert.equal(row.status, 'Not Paid');
        assert.equal(row.canPay, true);
    });

    it('puts only the unpaid employee portion on this salary month and later months', () => {
        const shared = {
            bill: bill({
                paymentBy: 'company',
                employeeDiffAmount: 500,
                companyPayAmount: 426.66,
                status: 'Paid',
            }),
            employeeIds,
        };
        assert.equal(unpaidEmployeePortionOnSalaryMonth({ ...shared, salaryMonth: '2026-11' }), 274.16);
        assert.equal(unpaidEmployeePortionOnSalaryMonth({ ...shared, salaryMonth: '2026-09' }), 274.16);
        assert.equal(unpaidEmployeePortionOnSalaryMonth({ ...shared, salaryMonth: '2026-08' }), 0);
        assert.equal(
            unpaidEmployeePortionOnSalaryMonth({
                ...shared,
                salaryMonth: '2026-11',
                zohoExpenseMatched: true,
            }),
            0,
        );
    });

    it('does not offer pay when this employee has no portion', () => {
        const row = summarizeUtilityPortionSettlement({
            bill: bill({
                zohoLineItems: [],
                payByEmployeeId: 'VEGA-HR-0999',
                employeePayAmount: 40,
            }),
            employeeIds,
        });
        assert.equal(row.portion, 0);
        assert.equal(row.canPay, false);
    });
});
