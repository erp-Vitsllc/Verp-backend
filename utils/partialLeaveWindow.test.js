import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describePartialLeave, leaveListDuration, partialLeaveOutcome } from './partialLeaveWindow.js';

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

    it('marks a half day taken without approval as late arrival', () => {
        const result = partialLeaveOutcome(
            {
                date: '2026-10-05',
                statusKey: 'on_office',
                timeIn: '13:30',
                timeOut: '18:00',
            },
            scheduledWeek,
        );
        assert.equal(result.statusKey, 'late_arrived');
        assert.equal(result.statusLabel, 'Late Arrival');
        assert.equal(result.leaveRequestDayPart, '');
        assert.equal(result.leaveDayFraction, 0);
        assert.equal(result.reason, 'Late arrival without approval');
    });

    it('marks an early punch-out without approval as early go', () => {
        const result = partialLeaveOutcome(
            {
                date: '2026-10-05',
                statusKey: 'on_office',
                timeIn: '09:00',
                timeOut: '13:30',
            },
            scheduledWeek,
        );
        assert.equal(result.statusKey, 'early_go');
        assert.equal(result.statusLabel, 'Early Go');
        assert.equal(result.leaveRequestSession, 'pm');
    });

    it('rewrites a stored unauthorized quarter day as late arrival', () => {
        const result = partialLeaveOutcome(
            {
                date: '2026-10-10',
                statusKey: 'unauthorized_leave',
                statusLabel: 'Unauthorized Quarter Day (AM)',
                leaveRequestDayPart: 'quarter',
                leaveRequestSession: 'am',
                timeIn: '11:30',
                timeOut: '21:19',
                reason: 'Unauthorized Quarter Day taken without an approved request',
            },
            scheduledWeek,
        );
        assert.equal(result.statusKey, 'late_arrived');
        assert.equal(result.leaveRequestDayPart, '');
        assert.equal(result.reason, 'Late arrival without approval');
    });

    it('leaves a full day with no punch as unauthorized leave', () => {
        const result = partialLeaveOutcome(
            {
                date: '2026-10-07',
                statusKey: 'unauthorized_leave',
                statusLabel: 'Unauthorized Leave',
                reason: 'No punch-in or punch-out (auto at midnight)',
                timeIn: '',
                timeOut: '',
            },
            scheduledWeek,
        );
        assert.equal(result, null);
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

describe('leave list duration', () => {
    it('labels a whole day as full time', () => {
        assert.deepEqual(
            leaveListDuration({ date: '2026-10-05', leaveRequestDayPart: 'full' }, scheduledWeek),
            { hours: null, label: 'Full time' },
        );
    });

    it('labels a quarter day with its hours', () => {
        assert.deepEqual(
            leaveListDuration(
                { date: '2026-10-05', leaveRequestDayPart: 'quarter', leaveRequestSession: 'am' },
                scheduledWeek,
            ),
            { hours: 2.25, label: '2 Hours 15 Min' },
        );
    });

    it('uses the stored working-day hours for a half day', () => {
        assert.deepEqual(
            leaveListDuration({
                date: '2026-10-05',
                leaveRequestDayPart: 'half',
                flexibleRequiredHours: 10,
            }),
            { hours: 5, label: '5 Hours' },
        );
    });
});
