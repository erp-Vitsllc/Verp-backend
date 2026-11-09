import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultWeek } from './workingTimeHelpers.js';
import { leavePageApprovedOtHours, sumLeavePageApprovedOtHours } from './leavePageApprovedOt.js';

test('approved overtime with no leave-page note is not added', () => {
    const hours = sumLeavePageApprovedOtHours(
        [{
            date: '2026-10-05',
            statusKey: 'on_office',
            timeIn: '18:00',
            timeOut: '20:00',
            flexibleOtStatus: 'approved',
            flexibleOtApprovedHours: 2,
        }],
        '2026-10',
        {},
        '2026-10-31',
    );
    assert.equal(hours, 0);
});

test('the leave page total uses the noted approved hours', () => {
    const hours = sumLeavePageApprovedOtHours(
        [{
            date: '2026-10-05',
            statusKey: 'on_office',
            timeIn: '18:00',
            timeOut: '20:00',
            flexibleOtStatus: 'approved',
            flexibleOtApprovedHours: 4,
        }],
        '2026-10',
        { '2026-10-05': { otHours: 2, givenTo: '', takenFrom: '' } },
        '2026-10-31',
    );
    assert.equal(hours, 2);
});

test('a finished month pays the same approved overtime the leave page shows', async () => {
    const hours = await leavePageApprovedOtHours({
        records: [{
            date: '2026-10-05',
            statusKey: 'on_office',
            timeIn: '18:00',
            timeOut: '20:00',
            flexibleOtStatus: 'approved',
            flexibleOtApprovedHours: 2,
        }],
        monthKey: '2026-10',
        countTo: '2026-10-31',
        daily: 100,
        week: defaultWeek(),
        holidayDates: new Set(),
        monthlySalary: 3100,
    });
    assert.equal(hours, 2);
});
