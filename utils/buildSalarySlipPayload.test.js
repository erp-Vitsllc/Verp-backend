import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { amountInWordsAed, monthKeyOf, yearlyEndOfServiceBenefit } from './buildSalarySlipPayload.js';

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
