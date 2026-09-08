import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    firstSalaryMonthAfterEnrollment,
    resolveExistingSalaryEnrollmentFromMonth,
    resolveNewSalaryEnrollmentFromMonth,
    salarySlipMonthAllowed,
    salarySlipMonthRange,
} from './salaryEnrollmentStartMonth.js';

const SEP_8 = new Date('2026-09-08T06:00:00.000Z');

describe('salaryEnrollmentStartMonth', () => {
    it('starts new enrollments on the 1st of the following month', () => {
        assert.equal(firstSalaryMonthAfterEnrollment('2026-09', SEP_8), '2026-10');
        assert.equal(
            resolveNewSalaryEnrollmentFromMonth({
                requestedYm: '2026-09',
                verpStartYm: '2026-09',
                now: SEP_8,
            }),
            '2026-10',
        );
    });

    it('keeps a requested start that is already after next month', () => {
        assert.equal(
            resolveNewSalaryEnrollmentFromMonth({
                requestedYm: '2026-12',
                now: SEP_8,
            }),
            '2026-12',
        );
    });

    it('does not pull an existing enrollment back to the current month', () => {
        assert.equal(
            resolveExistingSalaryEnrollmentFromMonth({
                verpStartYm: '2026-09',
                currentFromMonth: '2026-10',
            }),
            '2026-10',
        );
    });

    it('hides the current month until the employee is enrolled', () => {
        assert.deepEqual(
            salarySlipMonthRange({
                enrolled: false,
                verpStartYm: '2026-09',
                policyStartYm: '2026-09',
                now: SEP_8,
            }),
            [],
        );
    });

    it('lists months only from the enrollment start once that month has begun', () => {
        assert.deepEqual(
            salarySlipMonthRange({
                enrolled: true,
                fromMonth: '2026-10',
                now: SEP_8,
            }),
            [],
        );
        assert.deepEqual(
            salarySlipMonthRange({
                enrolled: true,
                fromMonth: '2026-08',
                now: SEP_8,
            }),
            ['2026-08', '2026-09'],
        );
    });

    it('blocks slip open before enrollment or before fromMonth', () => {
        assert.equal(salarySlipMonthAllowed('2026-09', { enrolled: false, fromMonth: '' }), false);
        assert.equal(salarySlipMonthAllowed('2026-09', { enrolled: true, fromMonth: '2026-10' }), false);
        assert.equal(salarySlipMonthAllowed('2026-10', { enrolled: true, fromMonth: '2026-10' }), true);
    });
});
