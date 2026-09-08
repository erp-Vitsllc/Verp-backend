import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    amountInWordsAed,
    monthKeyOf,
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
