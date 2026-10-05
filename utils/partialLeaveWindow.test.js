import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describePartialLeave, partialLeaveOutcome } from './partialLeaveWindow.js';

const scheduledWeek = {
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

describe('partial leave window', () => {
    it('describes a scheduled quarter day AM and PM', () => {
        const am = describePartialLeave({
            week: scheduledWeek,
            dateKey: '2026-10-05',
            dayPart: 'quarter',
            session: 'am',
        });
        assert.match(am.message, /2 hrs 15 min authorized quarter day \(AM\)/);
        assert.match(am.message, /9:00 AM–11:15 AM/);
        assert.match(am.message, /11:15 AM–6:00 PM/);
        assert.match(am.message, /punch in after 11:15 AM/);

        const pm = describePartialLeave({
            week: scheduledWeek,
            dateKey: '2026-10-05',
            dayPart: 'quarter',
            session: 'pm',
        });
        assert.match(pm.message, /3:45 PM–6:00 PM/);
        assert.match(pm.message, /9:00 AM–3:45 PM/);
        assert.match(pm.message, /punch out before 3:45 PM/);
    });

    it('describes flexible half day in hours only', () => {
        const result = describePartialLeave({
            week: { timingMode: 'flexible', hoursPerDay: 10 },
            dateKey: '2026-10-05',
            dayPart: 'half',
            session: 'am',
        });
        assert.equal(result.flexible, true);
        assert.match(result.message, /5 hrs authorized half day \(AM\)/);
        assert.doesNotMatch(result.message, /AM–/);
    });

    it('marks a half day taken without approval as unauthorized', () => {
        const result = partialLeaveOutcome(
            {
                date: '2026-10-05',
                statusKey: 'on_office',
                timeIn: '13:30',
                timeOut: '18:00',
            },
            scheduledWeek,
        );
        assert.equal(result.statusKey, 'unauthorized_leave');
        assert.equal(result.leaveRequestDayPart, 'half');
        assert.equal(result.leaveDayFraction, 0.5);
    });

    it('doubles an approved quarter day when the punch is outside the window', () => {
        const result = partialLeaveOutcome(
            {
                date: '2026-10-05',
                statusKey: 'authorized_leave',
                leaveRequestStatus: 'approved',
                leaveRequestDayPart: 'quarter',
                leaveRequestSession: 'am',
                timeIn: '12:00',
                timeOut: '18:00',
            },
            scheduledWeek,
        );
        assert.equal(result.leaveDeductionTimes, 2);
    });
});
