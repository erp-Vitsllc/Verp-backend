import assert from 'node:assert/strict';
import test from 'node:test';
import { dayHasWaivableDeduction, isDeductionWaived, isHourLossWaived } from './deductionWaive.js';

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

test('approved zero hours waive the loss, and a positive approval does not', () => {
    assert.equal(isHourLossWaived({ hourAdjustStatus: 'approved', hoursApproved: 0 }), true);
    assert.equal(isHourLossWaived({ hourAdjustStatus: 'approved', hoursApproved: 2 }), false);
    assert.equal(isHourLossWaived({ hourAdjustStatus: 'pending', hoursApproved: 0 }), false);
});
