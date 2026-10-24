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
    it('opens one 30-day window on the 300th counted day and lapses it when the next cycle completes', () => {
        const workingDateKeys = keys(600);
        const result = buildAnnualLeaveWindows({
            workingDateKeys,
            cycleDays: 300,
            today: '2027-06-01',
        });
        assert.equal(result.windows.length, 2);
        assert.equal(result.windows[0].status, 'Lapsed');
        assert.equal(result.windows[0].remainingDays, 0);
        assert.equal(result.windows[0].balance, 30);
        assert.equal(result.windows[0].startDate, workingDateKeys[299]);
        assert.equal(result.windows[1].status, 'Active');
        assert.equal(result.windows[1].allowedDays, 30);
        assert.equal(result.remainingDays, 30);
    });

    it('counts annual leave inside the open window and blocks a request past the balance or end date', () => {
        const workingDateKeys = keys(300);
        const start = workingDateKeys[299];
        const result = buildAnnualLeaveWindows({
            workingDateKeys,
            annualLeaves: [{ dates: [start], status: 'approved' }],
            cycleDays: 300,
            today: start,
        });
        assert.equal(result.active.takenDays, 1);
        assert.equal(result.active.remainingDays, 29);
        const over = annualLeaveRequestBlock(result, {
            from: start,
            to: start,
            requestedDates: Array.from({ length: 30 }, () => start),
        });
        assert.equal(over.ok, false);
        const past = annualLeaveRequestBlock(result, {
            from: '2099-01-01',
            to: '2099-01-02',
            requestedDates: ['2099-01-02'],
        });
        assert.equal(past.ok, false);
    });
});
