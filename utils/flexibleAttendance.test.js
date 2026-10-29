import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    approvedOtRemainder,
    dayWorkedMinutes,
    flexibleExactLossHours,
    flexibleLossHours,
    flexibleMissedPayFraction,
    isCurrentMonthDate,
    isAuthorizedLeaveStatus,
    isNextDayCompOffAttendance,
    leaveStatusKeyForCount,
    splitApprovedOvertime,
    flexibleOtFieldsFromDuration,
    manualTimeOutDate,
    mapPunchWithoutOvertime,
    mergeFlexibleOtState,
} from './flexibleAttendance.js';

describe('mapPunchWithoutOvertime', () => {
    it('copies the real check-in and next-day check-out', () => {
        const punch = mapPunchWithoutOvertime({
            timeIn: '08:03:32',
            timeOut: '07:18:44',
            timeOutDate: '2026-10-09',
        });
        assert.equal(punch.timeIn, '08:03:32');
        assert.equal(punch.timeOut, '07:18:44');
        assert.equal(punch.timeOutDate, '2026-10-09');
        assert.equal(punch.overtimeOnly, false);
    });

    it('keeps a same-day check-out', () => {
        const punch = mapPunchWithoutOvertime({
            timeIn: '08:00',
            timeOut: '16:00',
        });
        assert.equal(punch.timeIn, '08:00');
        assert.equal(punch.timeOut, '16:00');
        assert.equal(punch.timeOutDate, '');
        assert.equal(punch.overtimeOnly, false);
    });

    it('keeps a real check-in when the check-out is only overtime', () => {
        const punch = mapPunchWithoutOvertime({
            timeIn: '08:03',
            timeOut: 'OT',
        });
        assert.equal(punch.timeIn, '08:03');
        assert.equal(punch.timeOut, '');
        assert.equal(punch.overtimeOnly, false);
    });

    it('does not copy a day that is only overtime', () => {
        const punch = mapPunchWithoutOvertime({
            timeIn: 'OT',
            timeOut: 'OT',
        });
        assert.equal(punch.timeIn, '');
        assert.equal(punch.timeOut, '');
        assert.equal(punch.overtimeOnly, true);
    });
});

describe('dayWorkedMinutes', () => {
    it('adds an earlier same-day session to the latest check-in and check-out', () => {
        const minutes = dayWorkedMinutes({
            date: '2026-10-12',
            timeIn: '13:00',
            timeOut: '18:00',
            punchSessions: [{ timeIn: '09:00', timeOut: '12:00' }],
        });
        assert.equal(minutes, 8 * 60);
    });
});

describe('flexibleOtFieldsFromDuration', () => {
    it('shows overtime once the required day plus one hour is complete, and counts that hour', () => {
        const fields = flexibleOtFieldsFromDuration({
            isFlexible: true,
            date: '2026-10-05',
            timeIn: '09:00',
            timeOut: '19:00',
            requiredHours: 9,
            statusKey: 'on_office',
        });
        assert.equal(fields.flexibleOtHours, 1);
        assert.equal(fields.flexibleWorkedHours, 10);
    });

    it('counts every hour after the required day once the overtime button applies', () => {
        const fields = flexibleOtFieldsFromDuration({
            isFlexible: true,
            date: '2026-10-05',
            timeIn: '09:00',
            timeOut: '20:00',
            requiredHours: 9,
            statusKey: 'on_office',
        });
        assert.equal(fields.flexibleOtHours, 2);
    });

    it('keeps overtime on a next-day checkout that runs past the required day', () => {
        const fields = flexibleOtFieldsFromDuration({
            isFlexible: true,
            date: '2026-10-15',
            timeIn: '08:14:35',
            timeOut: '03:46:03',
            timeOutDate: '2026-10-16',
            requiredHours: 10,
            statusKey: 'on_office',
        });
        assert.equal(fields.flexibleWorkedHours, 19.53);
        assert.ok(fields.flexibleOtHours >= 9);
    });

    it('hides overtime until the extra hour after the required day is complete', () => {
        const fields = flexibleOtFieldsFromDuration({
            isFlexible: true,
            date: '2026-10-05',
            timeIn: '09:00',
            timeOut: '18:30',
            requiredHours: 9,
            statusKey: 'on_office',
        });
        assert.equal(fields.flexibleOtHours, 0);
        assert.equal(fields.flexibleWorkedHours, 9.5);
    });

    it('counts every worked hour as overtime on a holiday or weekly off', () => {
        const fields = flexibleOtFieldsFromDuration({
            isFlexible: true,
            nonWorking: true,
            date: '2026-10-05',
            timeIn: '09:00',
            timeOut: '17:00',
            requiredHours: 9,
            statusKey: 'on_office',
        });
        assert.equal(fields.flexibleOtHours, 8);
        assert.equal(fields.flexibleRequiredHours, 0);
    });

    it('keeps overtime when a mispunch day still has check-in and next-day check-out', () => {
        const fields = flexibleOtFieldsFromDuration({
            isFlexible: true,
            date: '2026-10-22',
            timeIn: '08:04:00',
            timeOut: '07:00:00',
            timeOutDate: '2026-10-23',
            requiredHours: 10,
            statusKey: 'mispunch',
        });
        assert.equal(fields.flexibleWorkedHours, 22.93);
        assert.equal(fields.flexibleOtHours, 12.93);
    });

    it('still ignores a mispunch that has no check-out', () => {
        const fields = flexibleOtFieldsFromDuration({
            isFlexible: true,
            date: '2026-10-22',
            timeIn: '08:04:00',
            timeOut: '',
            requiredHours: 10,
            statusKey: 'mispunch',
        });
        assert.equal(fields.flexibleOtHours, 0);
    });

    it('clears overtime when check-in or check-out is missing', () => {
        const fields = flexibleOtFieldsFromDuration({
            isFlexible: true,
            date: '2026-10-05',
            timeIn: '09:00',
            timeOut: '',
            requiredHours: 9,
            statusKey: 'on_office',
        });
        assert.equal(fields.flexibleOtHours, 0);
    });
});

describe('mergeFlexibleOtState', () => {
    it('clears a request when the edited hours no longer contain overtime', () => {
        const next = mergeFlexibleOtState(
            { flexibleOtHours: 2, flexibleOtStatus: 'pending', flexibleOtApprovedHours: 2 },
            { flexibleWorkedHours: 10, flexibleRequiredHours: 9, flexibleOtHours: 0 },
        );
        assert.equal(next.changed, true);
        assert.equal(next.flexibleOtStatus, '');
        assert.equal(next.flexibleOtApprovedHours, 0);
        assert.equal(next.flexibleOtReason, '');
    });

    it('keeps the request when the duration still has the same overtime', () => {
        const next = mergeFlexibleOtState(
            { flexibleOtHours: 2, flexibleOtStatus: 'pending', flexibleOtApprovedHours: 2 },
            { flexibleWorkedHours: 12, flexibleRequiredHours: 9, flexibleOtHours: 2 },
        );
        assert.equal(next.changed, false);
        assert.equal(next.flexibleOtStatus, undefined);
    });
});

describe('splitApprovedOvertime', () => {
    it('keeps approved hours as overtime when they are shorter than the working day', () => {
        assert.deepEqual(splitApprovedOvertime(8, 10), {
            nextDay: false,
            dayHours: 0,
            remainderHours: 8,
        });
    });

    it('marks the next day present when approved hours equal the working day', () => {
        assert.deepEqual(splitApprovedOvertime(10, 10), {
            nextDay: true,
            dayHours: 10,
            remainderHours: 0,
        });
    });

    it('keeps the hours above the working day as overtime on the next day', () => {
        assert.deepEqual(splitApprovedOvertime(12, 10), {
            nextDay: true,
            dayHours: 10,
            remainderHours: 2,
        });
    });
});

describe('approvedOtRemainder', () => {
    it('keeps overtime when the hours are 10 or less', () => {
        assert.equal(approvedOtRemainder(10), 10);
        assert.equal(approvedOtRemainder(8.5), 8.5);
    });

    it('uses the full overtime for the next day when the hours are more than 10', () => {
        assert.equal(approvedOtRemainder(10.5), 0);
        assert.equal(approvedOtRemainder(15), 0);
    });
});

describe('manualTimeOutDate', () => {
    it('treats a later check-out as the same day and an earlier one as the next day', () => {
        assert.equal(manualTimeOutDate('2026-10-05', '09:00', '18:00'), '');
        assert.equal(manualTimeOutDate('2026-10-05', '22:00', '06:00'), '2026-10-06');
    });
});

describe('flexibleLossHours', () => {
    const week = {
        timingMode: 'flexible',
        hoursPerDay: 10,
        monday: { isOffDay: false, workingHours: 10 },
    };

    it('counts a finished hour only, so 45 minutes does not add an hour', () => {
        assert.equal(flexibleLossHours({ date: '2026-10-05', flexibleWorkedHours: 7 }, week), 3);
        assert.equal(flexibleLossHours({ date: '2026-10-05', flexibleWorkedHours: 7.75 }, week), 3);
    });

    it('uses the punches when worked hours were not stored', () => {
        assert.equal(
            flexibleLossHours(
                { date: '2026-10-05', timeIn: '09:00', timeOut: '16:30', flexibleWorkedHours: 0 },
                week,
            ),
            3,
        );
    });

    it('is zero when the worked hours cover the day', () => {
        assert.equal(flexibleLossHours({ date: '2026-10-05', flexibleWorkedHours: 10.2 }, week), 0);
    });

    it('turns two missed hours on a ten-hour day into four tenths until the hours are approved', () => {
        const record = { date: '2026-10-05', statusKey: 'late_arrived', flexibleWorkedHours: 8 };
        assert.equal(flexibleMissedPayFraction(record, week), 0.4);
        assert.equal(
            flexibleMissedPayFraction(
                { ...record, statusKey: 'early_go', hourAdjustStatus: 'approved', hoursApproved: 1 },
                week,
            ),
            0.1,
        );
        assert.equal(flexibleMissedPayFraction({ ...record, statusKey: 'on_office' }, week), 0);
    });

    it('keeps the minutes in the deduction instead of rounding up to the next hour', () => {
        const record = {
            date: '2026-10-05',
            statusKey: 'late_arrived',
            timeIn: '16:50',
            timeOut: '23:05',
            flexibleWorkedHours: 6,
        };
        assert.equal(flexibleExactLossHours(record, week), 3.75);
        assert.equal(flexibleMissedPayFraction(record, week), 0.75);
    });
});

describe('isCurrentMonthDate', () => {
    it('accepts any day in the overtime month', () => {
        assert.equal(isCurrentMonthDate('2026-10-10', '2026-10-01'), true);
        assert.equal(isCurrentMonthDate('2026-10-10', '2026-10-31'), true);
        assert.equal(isCurrentMonthDate('2026-10-10', '2026-11-01'), false);
        assert.equal(isCurrentMonthDate('2026-10-10', ''), false);
    });
});

describe('isAuthorizedLeaveStatus', () => {
    it('accepts authorized leave and the Auth label', () => {
        assert.equal(isAuthorizedLeaveStatus('authorized_leave', 'Authorized Leave'), true);
        assert.equal(isAuthorizedLeaveStatus('on_office', 'Auth'), true);
        assert.equal(isAuthorizedLeaveStatus('on_office', 'Auth Leave'), true);
        assert.equal(isAuthorizedLeaveStatus('on_office', 'Present'), false);
    });
});

describe('next day comp-off attendance', () => {
    it('counts next-day attendance as comp-off leave', () => {
        const row = {
            statusKey: 'on_office',
            timeIn: 'OT',
            timeOut: 'OT',
            flexibleFromOtDate: '2026-10-05',
        };
        assert.equal(isNextDayCompOffAttendance(row), true);
        assert.equal(leaveStatusKeyForCount(row), 'compoff_leave');
    });

    it('keeps a marked comp-off leave as comp-off leave', () => {
        const row = { statusKey: 'compoff_leave', timeIn: '', timeOut: '' };
        assert.equal(isNextDayCompOffAttendance(row), false);
        assert.equal(leaveStatusKeyForCount(row), 'compoff_leave');
    });

    it('leaves a normal present day unchanged', () => {
        const row = { statusKey: 'on_office', timeIn: '08:00', timeOut: '18:00' };
        assert.equal(isNextDayCompOffAttendance(row), false);
        assert.equal(leaveStatusKeyForCount(row), 'on_office');
    });
});
