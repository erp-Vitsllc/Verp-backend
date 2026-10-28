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
    it('starts at the contract joining date and lapses after the next eligible date', () => {
        const result = buildAnnualLeaveWindows({
            joiningDate: '2024-01-01',
            workingDateKeys: keys(925),
            cycleDays: 300,
            today: '2026-10-26',
        });
        assert.equal(result.completedCycles, 3);
        assert.equal(result.remainderDays, 25);
        assert.equal(result.windows.length, 3);
        assert.equal(result.windows[0].startDate, '2024-01-01');
        assert.equal(result.windows[0].endDate, '2024-12-31');
        assert.equal(result.windows[0].takeUntil, '2025-12-31');
        assert.equal(result.windows[0].status, 'Lapsed');
        assert.equal(result.windows[1].startDate, '2025-01-01');
        assert.equal(result.windows[1].endDate, '2025-12-31');
        assert.equal(result.windows[1].status, 'Active');
        assert.equal(result.windows[1].balance, 30);
        assert.equal(result.windows[2].startDate, '2026-01-01');
        assert.equal(result.windows[2].status, 'Active');
    });

    it('counts leave through the next row leave eligible date and spills past 30', () => {
        const result = buildAnnualLeaveWindows({
            joiningDate: '2024-01-01',
            workingDateKeys: keys(300),
            annualLeaves: [{ dates: ['2025-03-01', '2025-03-02', '2026-02-01'], status: 'approved' }],
            cycleDays: 300,
            today: '2025-06-01',
        });
        assert.equal(result.windows[0].takenDays, 2);
        assert.equal(result.windows[0].balance, 28);
        assert.equal(result.windows[0].status, 'Active');
        assert.equal(result.windows[0].takeUntil, '2025-12-31');
        assert.equal(result.windows[1].takenDays, 1);
        assert.equal(result.windows[1].status, 'Inactive');
    });

    it('counts the entered day total when it is higher than the calendar dates', () => {
        const dates = [];
        for (let day = 0; day < 37; day += 1) {
            const date = new Date('2023-09-01T00:00:00');
            date.setDate(date.getDate() + day);
            const y = date.getFullYear();
            const m = String(date.getMonth() + 1).padStart(2, '0');
            const d = String(date.getDate()).padStart(2, '0');
            dates.push(`${y}-${m}-${d}`);
        }
        const result = buildAnnualLeaveWindows({
            joiningDate: '2023-08-24',
            workingDateKeys: keys(600, '2023-08-24'),
            annualLeaves: [{ dates, days: 52, startDate: dates[0], status: 'approved' }],
            cycleDays: 300,
            today: '2026-10-26',
        });
        assert.equal(result.windows[0].takenDays, 52);
        assert.equal(result.windows[0].balance, 0);
        assert.equal(result.windows[1].takenDays, 0);
    });

    it('moves days over 30 onto the next row', () => {
        const taken = [];
        for (let day = 1; day <= 45; day += 1) {
            const date = new Date('2024-02-01T00:00:00');
            date.setDate(date.getDate() + day);
            const y = date.getFullYear();
            const m = String(date.getMonth() + 1).padStart(2, '0');
            const d = String(date.getDate()).padStart(2, '0');
            taken.push(`${y}-${m}-${d}`);
        }
        const result = buildAnnualLeaveWindows({
            joiningDate: '2024-01-01',
            workingDateKeys: keys(600),
            annualLeaves: [{ dates: taken, status: 'approved' }],
            cycleDays: 300,
            today: '2025-06-01',
        });
        assert.equal(result.windows[0].takenDays, 45);
        assert.equal(result.windows[0].balance, 0);
        assert.equal(result.windows[1].takenDays, 0);
        assert.equal(result.windows[1].balance, 30);
    });

    it('sends the days past 30 to the next row when that leave date is inside it', () => {
        const september = [];
        for (let day = 11; day <= 25; day += 1) september.push(`2023-09-${String(day).padStart(2, '0')}`);
        const january = [];
        for (let day = 6; day <= 21; day += 1) january.push(`2025-01-${String(day).padStart(2, '0')}`);
        const nextJanuary = [];
        for (let day = 5; day <= 10; day += 1) nextJanuary.push(`2026-01-${String(day).padStart(2, '0')}`);
        const result = buildAnnualLeaveWindows({
            joiningDate: '2023-08-24',
            workingDateKeys: keys(600, '2023-08-24'),
            annualLeaves: [
                { id: 'sep', dates: september, days: 15, startDate: '2023-09-11', endDate: '2023-09-25', status: 'approved' },
                { id: 'jan', dates: january, days: 31, startDate: '2025-01-06', endDate: '2025-01-21', status: 'approved' },
                { id: 'jan26', dates: nextJanuary, days: 6, startDate: '2026-01-05', endDate: '2026-01-10', status: 'approved' },
            ],
            cycleDays: 300,
            today: '2026-10-28',
        });
        assert.equal(result.windows[0].startDate, '2023-08-24');
        assert.equal(result.windows[0].takeUntil, '2025-08-23');
        assert.equal(result.windows[0].takenDays, 30);
        assert.equal(result.windows[0].balance, 0);
        assert.equal(result.windows[1].startDate, '2024-08-24');
        assert.equal(result.windows[1].takeUntil, '2026-08-23');
        assert.equal(result.windows[1].takenDays, 22);
        assert.equal(result.windows[1].balance, 8);
        const firstPart = result.windows[0].entries.find((row) => row.id === 'jan');
        const secondPart = result.windows[1].entries.find((row) => row.id === 'jan');
        assert.equal(firstPart.actualDays, 15);
        assert.equal(firstPart.fromDate, '2025-01-06');
        assert.equal(firstPart.toDate, '2025-01-13');
        assert.equal(secondPart.actualDays, 16);
        assert.equal(secondPart.fromDate, '2025-01-14');
        assert.equal(secondPart.toDate, '2025-01-21');
        assert.equal(result.windows[0].entries.some((row) => row.id === 'jan26'), false);
        assert.equal(result.windows[1].entries.find((row) => row.id === 'jan26').actualDays, 6);
    });

    it('keeps the joining row inactive before 300 counted days', () => {
        const result = buildAnnualLeaveWindows({
            joiningDate: '2025-11-01',
            workingDateKeys: keys(100, '2025-11-03'),
            cycleDays: 300,
            today: '2026-06-01',
        });
        assert.equal(result.windows.length, 1);
        assert.equal(result.windows[0].status, 'Inactive');
        assert.equal(result.windows[0].allowedDays, 0);
        assert.equal(result.windows[0].balance, 0);
        const blocked = annualLeaveRequestBlock(result, {
            from: '2026-11-01',
            to: '2026-11-02',
            requestedDates: ['2026-11-01'],
        });
        assert.equal(blocked.ok, false);
    });
});
