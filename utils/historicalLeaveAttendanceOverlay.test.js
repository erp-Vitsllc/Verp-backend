import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    applyOverlayCounts,
    applyOverlayCountsToBalances,
    isHistoricalLeaveEntry,
    lastOverlayAnnualLeaveDate,
    mergeHistoricalCalendarRecords,
    overlayHistoricalLeave,
} from './historicalLeaveAttendanceOverlay.js';

const profile = {
    leaveRecords: [
        {
            _id: 'sick-1',
            leaveType: 'sick',
            source: 'manual',
            status: 'approved',
            fromDate: '2026-08-10',
            toDate: '2026-08-12',
            eligibleWorkingDays: 3,
            remarks: 'Flu',
        },
        {
            _id: 'auth-1',
            leaveType: 'authorized',
            source: 'manual',
            status: 'approved',
            eligibleWorkingDays: 5,
        },
        {
            _id: 'unauth-sys',
            leaveType: 'unauthorized',
            source: 'system',
            status: 'approved',
            eligibleWorkingDays: 9,
        },
        {
            _id: 'pending-1',
            leaveType: 'unauthorized',
            source: 'manual',
            status: 'pending',
            eligibleWorkingDays: 2,
        },
    ],
    annualLeaveRecords: [
        {
            _id: 'ann-1',
            startDate: '2026-07-01',
            endDate: '2026-07-10',
            actualDays: 8,
            source: 'manual',
            status: 'verified',
        },
    ],
};

describe('historical leave attendance overlay', () => {
    it('maps manual sick, annual, and count-only leave and skips system/pending', () => {
        const overlay = overlayHistoricalLeave(profile, {
            from: '2026-01-01',
            to: '2026-12-31',
        });
        assert.equal(overlay.extraCounts.sick_leave, 3);
        assert.equal(overlay.extraCounts.authorized_leave, 5);
        assert.equal(overlay.extraCounts.unauthorized_leave, 0);
        assert.equal(overlay.extraCounts.on_leave, 8);
        assert.equal(overlay.calendarRecords.length, 3 + 10);
        assert.equal(overlay.entries.filter((row) => row.countOnly).length, 1);
        assert.equal(
            overlay.entries.find((row) => row.statusKey === 'sick_leave')?.source,
            'Salary enrollment',
        );
    });

    it('clips dated leave to the requested period', () => {
        const overlay = overlayHistoricalLeave(profile, {
            from: '2026-08-01',
            to: '2026-08-31',
            includeCountOnly: false,
        });
        assert.equal(overlay.extraCounts.sick_leave, 3);
        assert.equal(overlay.extraCounts.on_leave, 0);
        assert.equal(overlay.calendarRecords.every((row) => row.date.startsWith('2026-08')), true);
    });

    it('does not overwrite an existing attendance day', () => {
        const overlay = overlayHistoricalLeave(profile, {
            from: '2026-08-01',
            to: '2026-08-31',
            includeCountOnly: false,
        });
        const merged = mergeHistoricalCalendarRecords(
            [{ date: '2026-08-10', statusKey: 'on_office' }],
            overlay.calendarRecords,
        );
        const day = merged.find((row) => row.date === '2026-08-10');
        assert.equal(day.statusKey, 'on_office');
        assert.equal(merged.some((row) => row.date === '2026-08-11'), true);
    });

    it('applies overlay days to counts and leave balances', () => {
        const counts = applyOverlayCounts({ sick_leave: 2 }, { sick_leave: 3, authorized_leave: 5 });
        assert.equal(counts.sick_leave, 5);
        assert.equal(counts.authorized_leave, 5);
        const balances = applyOverlayCountsToBalances(
            { sick_leave: { taken: 2, allowed: 15, remaining: 13, pending: 0, multiplier: 1 } },
            { sick_leave: 3 },
        );
        assert.equal(balances.sick_leave.taken, 5);
        assert.equal(balances.sick_leave.remaining, 10);
        assert.equal(lastOverlayAnnualLeaveDate([{ statusKey: 'on_leave', toDate: '2026-07-10' }], '2026-06-01'), '2026-07-10');
        assert.equal(isHistoricalLeaveEntry({ historical: true }), true);
        assert.equal(isHistoricalLeaveEntry({ source: 'Attendance' }), false);
    });

    it('keeps undated sick leave as a count-only dashboard row', () => {
        const overlay = overlayHistoricalLeave(
            {
                leaveRecords: [
                    {
                        _id: 'sick-count',
                        leaveType: 'sick',
                        source: 'manual',
                        status: 'approved',
                        eligibleWorkingDays: 4,
                    },
                ],
            },
            { from: '2026-01-01', to: '2026-12-31' },
        );
        assert.equal(overlay.extraCounts.sick_leave, 4);
        assert.equal(overlay.calendarRecords.length, 0);
        assert.equal(overlay.entries[0]?.countOnly, true);
    });
});
