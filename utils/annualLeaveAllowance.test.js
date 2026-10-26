import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildAnnualLeaveWindows, annualLeaveRequestBlock } from './annualLeaveAllowance.js';

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

describe('annual leave windows', () => {
    it('opens one row per completed 300 days, starting the year after joining', () => {
        const result = buildAnnualLeaveWindows({
            joiningDate: '2024-01-01',
            workingDateKeys: keys(925),
            cycleDays: 300,
            today: '2026-10-26',
        });
        assert.equal(result.completedCycles, 3);
        assert.equal(result.remainderDays, 25);
        assert.equal(result.windows.length, 3);
        assert.equal(result.windows[0].startDate, '2025-01-01');
        assert.equal(result.windows[0].endDate, '2025-12-31');
        assert.equal(result.windows[0].status, 'Lapsed');
        assert.equal(result.windows[1].startDate, '2026-01-01');
        assert.equal(result.windows[1].endDate, '2026-12-31');
        assert.equal(result.windows[1].status, 'Lapsed');
        assert.equal(result.windows[2].startDate, '2027-01-01');
        assert.equal(result.windows[2].endDate, '2027-12-31');
        assert.equal(result.windows[2].status, 'Active');
        assert.equal(result.windows[2].balance, 30);
    });

    it('counts annual leave taken inside that year against the 30-day balance', () => {
        const result = buildAnnualLeaveWindows({
            joiningDate: '2024-01-01',
            workingDateKeys: keys(300),
            annualLeaves: [{ dates: ['2025-03-01', '2025-03-02', '2026-02-01'], status: 'approved' }],
            cycleDays: 300,
            today: '2025-06-01',
        });
        assert.equal(result.windows.length, 1);
        assert.equal(result.windows[0].takenDays, 2);
        assert.equal(result.windows[0].balance, 28);
        assert.equal(result.windows[0].status, 'Active');
    });

    it('does not open a row before 300 counted days', () => {
        const result = buildAnnualLeaveWindows({
            joiningDate: '2025-11-01',
            workingDateKeys: keys(100, '2025-11-03'),
            cycleDays: 300,
            today: '2026-06-01',
        });
        assert.equal(result.windows.length, 0);
        const blocked = annualLeaveRequestBlock(result, {
            from: '2026-11-01',
            to: '2026-11-02',
            requestedDates: ['2026-11-01'],
        });
        assert.equal(blocked.ok, false);
    });
});
