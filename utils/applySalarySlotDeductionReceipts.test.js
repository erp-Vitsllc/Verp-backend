import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { salarySlipDeductionReceiptLines } from './applySalarySlotDeductionReceipts.js';

const loanId = '507f1f77bcf86cd799439011';
const advanceId = '507f1f77bcf86cd799439012';
const fineId = '507f1f77bcf86cd799439013';
const billId = '507f1f77bcf86cd799439014';

describe('salarySlipDeductionReceiptLines', () => {
    it('keeps only this month amounts that were added on the slip', () => {
        const lines = salarySlipDeductionReceiptLines({
            loanSchedule: [
                { type: 'Salary Advance', sourceId: '', thisMonthAmount: 0 },
                { type: 'Salary Advance', sourceId: advanceId, thisMonthAmount: 40 },
                { type: 'Loan', sourceId: loanId, thisMonthAmount: 100 },
                { type: 'Loan', sourceId: 'not-an-id', thisMonthAmount: 25 },
            ],
            fines: [
                { sourceId: fineId, thisMonthAmount: 20 },
                { sourceId: fineId, thisMonthAmount: 0 },
            ],
            utilities: [
                { sourceId: billId, thisMonthAmount: 15 },
                { sourceId: billId, thisMonth: '0.00' },
            ],
        });
        assert.deepEqual(lines, [
            { kind: 'advance', sourceId: advanceId, amount: 40 },
            { kind: 'loan', sourceId: loanId, amount: 100 },
            { kind: 'fine', sourceId: fineId, amount: 20 },
            { kind: 'utility', sourceId: billId, amount: 15 },
        ]);
    });
});
