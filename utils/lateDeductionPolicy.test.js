import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultWeek } from './workingTimeHelpers.js';
import {
    chargeableLateEventUnits,
    countDayLateInOutEvents,
    lateDeductionFromEvents,
} from './lateDeductionPolicy.js';

describe('late in/out combined events', () => {
    it('deducts from the combined total, not late in and late out separately', () => {
        assert.equal(chargeableLateEventUnits(2, 3), 0);
        assert.equal(chargeableLateEventUnits(3, 3), 1);
        assert.equal(chargeableLateEventUnits(5, 3), 1);
        assert.equal(chargeableLateEventUnits(6, 3), 2);
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

    it('turns three mixed late in/out events into one deduct unit', () => {
        const result = lateDeductionFromEvents(3, {
            lateInRules: [{ minutes: 30, events: 3, deduct: 'quarter' }],
            lateOutRules: [{ minutes: 30, events: 3, deduct: 'quarter' }],
        });
        assert.equal(result.combinedEvents, 3);
        assert.equal(result.units, 1);
        assert.equal(result.multiplier, 0.25);
    });
});
