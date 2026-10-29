import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildAnnualLeaveWindows, annualLeaveRequestBlock } from './annualLeaveAllowance.js';
import {
    buildAnnualLeaveCalendar,
    buildAnnualLeaveSelectionMessage,
    buildOpenAnnualLeaveSpans,
    markGroupLeaveDays,
} from './annualLeaveCalendar.js';

function keys(count, start = '2024-01-02') {
    const out = [];
    const cursor = new Date(`${start}T00:00:00`);
    while (out.length < count) {
        const y = cursor.getFullYear();
        const m = String(cursor.getMonth() + 1).padStart(2, '0');
        const d = String(cursor.getDate()).padStart(2, '0');
        out.push(`${y}-${m}-${d}`);
        cursor.setDate(cursor.getDate() + 1);
    }
    return out;
}

describe('annual leave calendar shade', () => {
    it('opens on the 300th counted working day and keeps earlier days closed', () => {
        const working = keys(300, '2024-01-02');
        const result = buildAnnualLeaveWindows({
            joiningDate: '2024-01-01',
            workingDateKeys: working,
            cycleDays: 300,
            today: '2025-06-01',
        });
        assert.equal(result.windows[0].eligibleOn, working[299]);
        assert.equal(result.countedDateKeys.length, 300);
        const calendar = buildAnnualLeaveCalendar({
            windows: result.windows,
            allowedDays: 30,
            cycleDays: 300,
            today: '2024-06-01',
            remainingDays: result.remainingDays,
        });
        assert.equal(calendar.openSpans[0].from, working[299]);
        assert.match(calendar.notice, /Holidays and weekly offs are not counted/);
        const early = buildAnnualLeaveSelectionMessage({
            calendar,
            allowance: result,
            from: '2024-02-01',
            to: '2024-02-03',
            requestedDates: ['2024-02-01'],
        });
        assert.match(early, /closed/);
        assert.match(early, /Choose a date on or after/);
    });

    it('keeps the row closed until 300 counted days exist', () => {
        const result = buildAnnualLeaveWindows({
            joiningDate: '2025-11-01',
            workingDateKeys: keys(100, '2025-11-03'),
            cycleDays: 300,
            today: '2026-06-01',
        });
        assert.equal(result.windows[0].status, 'Inactive');
        assert.equal(result.windows[0].eligibleOn, '');
        const calendar = buildAnnualLeaveCalendar({
            windows: result.windows,
            today: '2026-06-01',
            remainingDays: 0,
        });
        assert.equal(calendar.openSpans.length, 0);
        assert.match(calendar.notice, /not open yet/);
        assert.match(calendar.notice, /at least 5 days/);
    });

    it('does not open a period that has fewer than 5 days left', () => {
        const spans = buildOpenAnnualLeaveSpans(
            [
                {
                    status: 'Active',
                    eligibleOn: '2026-05-23',
                    takeUntil: '2027-05-22',
                    remainingDays: 4,
                },
            ],
            { minimumDays: 5, allowedDays: 30 },
        );
        assert.equal(spans.length, 0);
        const calendar = buildAnnualLeaveCalendar({
            windows: [
                {
                    status: 'Active',
                    eligibleOn: '2026-05-23',
                    takeUntil: '2027-05-22',
                    remainingDays: 4,
                },
            ],
            today: '2026-06-01',
            remainingDays: 4,
        });
        assert.match(calendar.notice, /4 days of annual leave left/);
        assert.match(calendar.notice, /at least 5 days/);
    });

    it('opens a future period on the day the next 300 working days complete', () => {
        const spans = buildOpenAnnualLeaveSpans([
            {
                status: 'Inactive',
                eligibleOn: '2026-05-23',
                takeUntil: '2027-05-22',
                remainingDays: 0,
            },
        ]);
        assert.deepEqual(spans, [{ from: '2026-05-23', to: '2027-05-22', remainingDays: 30 }]);
        const calendar = buildAnnualLeaveCalendar({
            windows: [
                {
                    status: 'Inactive',
                    eligibleOn: '2026-05-23',
                    takeUntil: '2027-05-22',
                    remainingDays: 0,
                },
            ],
            today: '2026-05-01',
            remainingDays: 0,
        });
        assert.match(calendar.notice, /23 May 2026/);
        const allowed = buildAnnualLeaveSelectionMessage({
            calendar,
            allowance: {
                allowedDays: 30,
                cycleDays: 300,
                windows: [
                    {
                        index: 1,
                        status: 'Inactive',
                        startDate: '2025-05-24',
                        endDate: '2026-05-23',
                        takeUntil: '2027-05-22',
                        eligibleOn: '2026-05-23',
                        remainingDays: 0,
                    },
                ],
            },
            from: '2026-05-23',
            to: '2026-05-27',
            requestedDates: ['2026-05-25', '2026-05-26', '2026-05-27'],
        });
        assert.equal(allowed, '');
    });

    it('allows leave on or after the eligible date of an inactive row', () => {
        const result = buildAnnualLeaveWindows({
            joiningDate: '2025-11-01',
            workingDateKeys: keys(100, '2025-11-03'),
            cycleDays: 300,
            today: '2026-06-01',
        });
        result.windows[0].eligibleOn = '2026-11-01';
        assert.ok(result.windows[0].takeUntil >= '2026-11-05');
        const opened = annualLeaveRequestBlock(result, {
            from: '2026-11-01',
            to: '2026-11-05',
            requestedDates: ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'],
        });
        assert.equal(opened.ok, true, opened.message);
        const early = annualLeaveRequestBlock(result, {
            from: '2026-08-01',
            to: '2026-08-02',
            requestedDates: ['2026-08-01'],
        });
        assert.equal(early.ok, false);
    });

    it('paints two days before and after someone else’s leave in yellow', () => {
        const marks = markGroupLeaveDays(
            [{ employeeMongoId: 'ninja', date: '2026-05-30' }],
            { applicantId: 'sandy', maxAllowed: 2 },
        );
        assert.deepEqual(marks.yellowSpans, [{ from: '2026-05-28', to: '2026-06-01' }]);
        assert.deepEqual(marks.cappedDates, []);
        assert.deepEqual(marks.ownLeaveDates, []);
    });

    it('blocks a day when other people already fill the group limit', () => {
        const marks = markGroupLeaveDays(
            [
                { employeeMongoId: 'a', date: '2026-05-30' },
                { employeeMongoId: 'b', date: '2026-05-30' },
                { employeeMongoId: 'sandy', date: '2026-05-18' },
            ],
            { applicantId: 'sandy', maxAllowed: 2 },
        );
        assert.deepEqual(marks.cappedDates, ['2026-05-30']);
        assert.deepEqual(marks.ownLeaveDates, ['2026-05-18']);
        const calendar = buildAnnualLeaveCalendar({
            windows: [
                {
                    status: 'Active',
                    eligibleOn: '2026-05-01',
                    takeUntil: '2026-12-31',
                    remainingDays: 30,
                },
            ],
            today: '2026-05-20',
            remainingDays: 30,
        });
        calendar.cappedDates = marks.cappedDates;
        calendar.ownLeaveDates = marks.ownLeaveDates;
        calendar.groupLabel = 'Workshop';
        calendar.maxAllowed = 2;
        calendar.maxPercent = 10;
        const message = buildAnnualLeaveSelectionMessage({
            calendar,
            allowance: {
                allowedDays: 30,
                windows: [
                    {
                        index: 1,
                        status: 'Active',
                        startDate: '2026-01-01',
                        takeUntil: '2026-12-31',
                        eligibleOn: '2026-05-01',
                        remainingDays: 30,
                    },
                ],
            },
            from: '2026-05-30',
            to: '2026-05-30',
            requestedDates: ['2026-05-30'],
        });
        assert.match(message, /30 May 2026 is already at the group limit/);
        assert.match(message, /Workshop/);
    });
});
