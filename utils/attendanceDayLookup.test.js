import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bestDayRecord, employeeAttendanceMatch, preferPunchedRows } from './attendanceDayLookup.js';

describe('preferPunchedRows', () => {
    it('keeps the check-in when an empty row for the same day comes first', () => {
        const rows = preferPunchedRows([
            { date: '2026-10-01', timeIn: '', statusKey: 'not_marked', updatedAt: '2026-10-01T04:00:00.000Z' },
            {
                date: '2026-10-01',
                timeIn: '07:45:02',
                statusKey: 'not_marked',
                statusLabel: 'On time',
                updatedAt: '2026-10-01T03:45:00.000Z',
            },
        ]);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].timeIn, '07:45:02');
    });

    it('does not let a historical day replace a live punch', () => {
        const picked = bestDayRecord(
            [
                { date: '2026-10-01', timeIn: '', historical: true, statusKey: 'on_leave' },
                { date: '2026-10-01', timeIn: '07:45:02', statusKey: 'on_office' },
            ],
            '2026-10-01',
        );
        assert.equal(picked.timeIn, '07:45:02');
    });
});

describe('employeeAttendanceMatch', () => {
    it('matches the profile id and the employee code', () => {
        const match = employeeAttendanceMatch({ _id: 'abc', employeeId: 'VEGA-HR-00008' });
        assert.deepEqual(match, {
            $or: [
                { employeeMongoId: 'abc' },
                { employeeId: 'VEGA-HR-00008' },
                { employeeMongoId: 'VEGA-HR-00008' },
            ],
        });
    });
});
