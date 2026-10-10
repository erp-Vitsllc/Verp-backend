import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    approvedOtRemainder,
    flexibleLossHours,
    flexibleNextDayChoices,
    isAuthorizedLeaveStatus,
    splitApprovedOvertime,
    flexibleOtFieldsFromDuration,
    manualTimeOutDate,
    mergeFlexibleOtState,
} from './flexibleAttendance.js';

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
});

describe('flexibleNextDayChoices', () => {
    it('offers the next day, this day, and yesterday', () => {
        assert.deepEqual(flexibleNextDayChoices('2026-10-10'), ['2026-10-11', '2026-10-10', '2026-10-09']);
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
