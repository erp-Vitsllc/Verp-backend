import assert from 'node:assert/strict';
import test from 'node:test';
import { dayHasWaivableDeduction, isDeductionWaived } from './deductionWaive.js';

test('mispunch, early go, late in, and leave days can have their deduction waived', () => {
    for (const statusKey of ['mispunch', 'early_go', 'late_arrived', 'unauthorized_leave', 'authorized_leave']) {
        assert.equal(dayHasWaivableDeduction({ statusKey }), true);
    }
    assert.equal(dayHasWaivableDeduction({ statusKey: 'on_office' }), false);
});

test('only an explicit waive clears the deduction', () => {
    assert.equal(isDeductionWaived({ deductionWaived: true }), true);
    assert.equal(isDeductionWaived({ deductionWaived: false }), false);
    assert.equal(isDeductionWaived({}), false);
});
