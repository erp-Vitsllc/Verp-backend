import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultWeek } from './workingTimeHelpers.js';
import {
    chargeableLateEventUnits,
    countDayLateInOutEvents,
    lateDeductionFromEvents,
} from './lateDeductionPolicy.js';

describe('late in/out combined events', () => {
    it('keeps the policy count free and deducts on the next event', () => {
        assert.equal(chargeableLateEventUnits(2, 3), 0);
        assert.equal(chargeableLateEventUnits(3, 3), 0);
        assert.equal(chargeableLateEventUnits(4, 3), 1);
        assert.equal(chargeableLateEventUnits(6, 3), 1);
        assert.equal(chargeableLateEventUnits(7, 3), 2);
    });

    it('counts late in and late out on the same day as two events toward the same pool', () => {
        const week = defaultWeek();
        const events = countDayLateInOutEvents({
            date: '2026-09-07',
            week,
            timeIn: '09:40',
            timeOut: '17:20',
            statusKey: 'early_go',
            minutesThreshold: 30,
        });
        assert.equal(events, 2);
    });

    it('does not count a late in below the shared minutes threshold', () => {
        const week = defaultWeek();
        const events = countDayLateInOutEvents({
            date: '2026-09-07',
            week,
            timeIn: '09:20',
            timeOut: '18:00',
            statusKey: 'late_arrived',
            minutesThreshold: 30,
        });
        assert.equal(events, 0);
    });

    it('uses the salary-policy count, so 4 free events deduct on the 5th', () => {
        const policy = { lateInRules: [{ events: 4, deduct: 'quarter' }] };
        assert.equal(lateDeductionFromEvents(4, policy).units, 0);
        assert.equal(lateDeductionFromEvents(4, policy).dayFraction, 0);
        const fifth = lateDeductionFromEvents(5, policy);
        assert.equal(fifth.units, 1);
        assert.equal(fifth.dayFraction, 0.25);
        assert.equal(lateDeductionFromEvents(8, policy).units, 1);
        assert.equal(lateDeductionFromEvents(9, policy).units, 2);
    });
});
