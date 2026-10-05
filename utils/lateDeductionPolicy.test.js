import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultWeek } from './workingTimeHelpers.js';
import {
    chargeableLateEventUnits,
    countDayLateInOutEvents,
    lateDeductionFromEvents,
    countExtraLateRules,
    lateInOutSummary,
    missedPunchDeduction,
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

    it('deducts each missed punch as full, half, or quarter from the group rule', () => {
        const eachQuarter = missedPunchDeduction(2, { missedPunchRule: { events: 0, deduct: 'quarter' } });
        assert.equal(eachQuarter.units, 2);
        assert.equal(eachQuarter.dayFraction, 0.5);

        const freeThenHalf = missedPunchDeduction(3, { missedPunchRule: { events: 2, deduct: 'half' } });
        assert.equal(freeThenHalf.units, 1);
        assert.equal(freeThenHalf.dayFraction, 0.5);

        const fromGroup = missedPunchDeduction(1, {
            missedPunchRule: { events: 0, deduct: 'full' },
            extraLateRules: [{ title: 'Missed punch', events: 0, deduct: 'quarter' }],
        });
        assert.equal(fromGroup.multiplier, 1);
    });

    it('applies only the highest extra late band and deducts every match when events are 0', () => {
        const week = {
            timingMode: 'scheduled',
            monday: {
                isOffDay: false,
                startHour: 9,
                startMinute: 0,
                startMeridiem: 'AM',
                endHour: 6,
                endMinute: 0,
                endMeridiem: 'PM',
            },
        };
        const policy = {
            extraLateRules: [
                { title: 'Late in', minutes: 90, events: 0, deduct: 'half' },
                { title: 'Late Out', minutes: 90, events: 0, deduct: 'half' },
                { title: 'Late in', minutes: 240, events: 0, deduct: 'full' },
                { title: 'Late Out', minutes: 250, events: 0, deduct: 'full' },
            ],
        };
        const charges = countExtraLateRules(
            [
                { date: '2026-10-05', statusKey: 'late_arrived', timeIn: '10:40', timeOut: '18:00' },
                { date: '2026-10-05', statusKey: 'on_office', timeIn: '13:00', timeOut: '13:00' },
            ],
            policy,
            week,
        );
        const halfIn = charges.find((row) => row.label === 'Late in 90 min');
        const fullIn = charges.find((row) => row.label === 'Late in 240 min');
        const halfOut = charges.find((row) => row.label === 'Late Out 90 min');
        const fullOut = charges.find((row) => row.label === 'Late Out 250 min');
        assert.equal(halfIn.count, 1);
        assert.equal(halfIn.dayFraction, 0.5);
        assert.equal(fullIn.count, 1);
        assert.equal(fullIn.dayFraction, 1);
        assert.equal(halfOut.count, 0);
        assert.equal(fullOut.count, 1);
        assert.equal(fullOut.dayFraction, 1);
    });

    it('counts a stricter late band once and leaves shorter lates on the shared allowance', () => {
        const week = {
            timingMode: 'scheduled',
            monday: {
                isOffDay: false,
                startHour: 9,
                startMinute: 0,
                startMeridiem: 'AM',
                endHour: 6,
                endMinute: 0,
                endMeridiem: 'PM',
            },
        };
        const policy = {
            lateInRules: [{ minutes: 15, events: 4, deduct: 'quarter' }],
            extraLateRules: [
                { title: 'Late in', minutes: 90, events: 0, deduct: 'half' },
                { title: 'Late Out', minutes: 90, events: 0, deduct: 'half' },
            ],
        };
        const summary = lateInOutSummary(
            [
                { date: '2026-10-05', statusKey: 'late_arrived', timeIn: '09:30', timeOut: '18:00' },
                { date: '2026-10-06', statusKey: 'late_arrived', timeIn: '10:40', timeOut: '18:00' },
            ],
            policy,
            {
                ...week,
                tuesday: week.monday,
            },
        );
        assert.equal(summary.sharedLateIn, 1);
        assert.equal(summary.lateIn.count, 2);
        assert.equal(summary.lateIn.dayFraction, 0.5);
        assert.equal(summary.lateOut.count, 0);
        assert.equal(summary.lateOut.dayFraction, 0);
    });
});
