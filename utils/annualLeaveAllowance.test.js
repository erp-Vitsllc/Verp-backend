import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildAnnualLeaveWindows, annualLeaveRequestBlock } from './annualLeaveAllowance.js';

function keys(count, start = '2025-01-01') {
    const out = [];
    const cursor = new Date(`${start}T00:00:00`);
    while (out.length < count) {
        const day = cursor.getDay();
        if (day !== 0 && day !== 6) {
            const y = cursor.getFullYear();
            const m = String(cursor.getMonth() + 1).padStart(2, '0');
            const d = String(cursor.getDate()).padStart(2, '0');
            out.push(`${y}-${m}-${d}`);
        }
        cursor.setDate(cursor.getDate() + 1);
    }
    return out;
}

describe('annual leave windows', () => {
    it('keeps the first 12 months as work and puts leave on the next row until 300 days are counted', () => {
        const result = buildAnnualLeaveWindows({
            joiningDate: '2025-11-01',
            workingDateKeys: [],
            cycleDays: 300,
            today: '2026-06-01',
        });
        assert.equal(result.windows.length, 1);
        assert.equal(result.windows[0].startDate, '2026-11-01');
        assert.equal(result.windows[0].endDate, '2027-10-31');
        assert.equal(result.windows[0].status, 'Not hit 300');
        assert.equal(result.windows[0].balance, 0);
        assert.equal(result.windows[0].takenDays, 0);
    });

    it('opens that next row once 300 days are counted, and only inside its start and end', () => {
        const result = buildAnnualLeaveWindows({
            joiningDate: '2025-11-01',
            workingDateKeys: keys(300, '2025-11-03'),
            cycleDays: 300,
            today: '2026-12-01',
        });
        assert.equal(result.windows.length, 1);
        assert.equal(result.windows[0].status, 'Active');
        assert.equal(result.windows[0].balance, 30);
        assert.equal(result.windows[0].startDate, '2026-11-01');
        assert.equal(result.windows[0].endDate, '2027-10-31');
        const duringWorkYear = annualLeaveRequestBlock(result, {
            from: '2026-05-01',
            to: '2026-05-02',
            requestedDates: ['2026-05-01', '2026-05-02'],
        });
        assert.equal(duringWorkYear.ok, false);
    });

    it('lapses the leave row when its end passes and shows the next row as not hit 300', () => {
        const result = buildAnnualLeaveWindows({
            joiningDate: '2025-11-01',
            workingDateKeys: keys(300, '2025-11-03'),
            cycleDays: 300,
            today: '2027-11-15',
        });
        assert.equal(result.windows[0].status, 'Lapsed');
        assert.equal(result.windows[0].remainingDays, 0);
        assert.equal(result.windows[1].startDate, '2027-11-01');
        assert.equal(result.windows[1].endDate, '2028-10-31');
        assert.equal(result.windows[1].status, 'Not hit 300');
        assert.equal(result.windows[1].balance, 0);
    });

    it('on the next 300, opens a second leave row and lapses the previous one', () => {
        const result = buildAnnualLeaveWindows({
            joiningDate: '2025-11-01',
            workingDateKeys: keys(600, '2025-11-03'),
            cycleDays: 300,
            today: '2027-01-15',
        });
        assert.equal(result.completedCycles, 2);
        assert.equal(result.remainderDays, 0);
        assert.equal(result.windows[0].status, 'Lapsed');
        assert.equal(result.windows[1].status, 'Active');
        assert.equal(result.windows[1].balance, 30);
        assert.equal(result.windows[1].startDate, '2027-11-01');
        assert.equal(result.windows.length, 2);
    });

    it('counts annual leave inside the open window and blocks a request past the balance', () => {
        const result = buildAnnualLeaveWindows({
            joiningDate: '2025-11-01',
            workingDateKeys: keys(300, '2025-11-03'),
            annualLeaves: [{ dates: ['2026-12-02'], status: 'approved' }],
            cycleDays: 300,
            today: '2026-12-15',
        });
        assert.equal(result.active.takenDays, 1);
        assert.equal(result.active.remainingDays, 29);
        const over = annualLeaveRequestBlock(result, {
            from: '2026-12-10',
            to: '2026-12-10',
            requestedDates: Array.from({ length: 30 }, () => '2026-12-10'),
        });
        assert.equal(over.ok, false);
    });
});
