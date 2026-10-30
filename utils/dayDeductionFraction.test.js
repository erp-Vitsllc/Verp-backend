import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dayDeductionFraction } from './dayDeductionFraction.js';
import { defaultWeek } from './workingTimeHelpers.js';

const week = defaultWeek();

function lateDay(date, timeIn = '09:40') {
    return {
        employeeMongoId: 'emp',
        date,
        statusKey: 'late_arrived',
        timeIn,
        timeOut: '18:00',
    };
}

describe('day deduction fraction', () => {
    it('is zero when the leave policy deducts nothing', () => {
        const row = { date: '2026-10-05', statusKey: 'authorized_leave' };
        assert.equal(dayDeductionFraction(row, [row], { authorizedLeaveDeductionDays: 0 }, week), 0);
        assert.equal(dayDeductionFraction(row, [row], { authorizedLeaveDeductionDays: null }, week), 0);
    });

    it('uses the leave multiplier when that day deducts', () => {
        const full = { date: '2026-10-05', statusKey: 'unauthorized_leave' };
        const half = { date: '2026-10-06', statusKey: 'authorized_leave', leaveRequestDayPart: 'half' };
        assert.equal(dayDeductionFraction(full, [full], { unauthorizedLeaveDeductionDays: 2 }, week), 2);
        assert.equal(dayDeductionFraction(half, [half], { authorizedLeaveDeductionDays: 1 }, week), 0.5);
    });

    it('hides a late day that is still inside the free allowance', () => {
        const rows = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'].map((date) => lateDay(date));
        const policy = { lateInRules: [{ minutes: 15, events: 4, deduct: 'quarter' }] };
        assert.equal(dayDeductionFraction(rows[0], rows, policy, week), 0);
    });

    it('counts a late day once the month deduction is above zero', () => {
        const rows = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'].map((date) => lateDay(date));
        const policy = { lateInRules: [{ minutes: 15, events: 4, deduct: 'quarter' }] };
        assert.equal(dayDeductionFraction(rows[4], rows, policy, week), 0.25);
    });

    it('is zero when the late minutes stay under the deduction threshold', () => {
        const row = lateDay('2026-10-05', '09:10');
        const policy = { lateInRules: [{ minutes: 30, events: 0, deduct: 'full' }] };
        assert.equal(dayDeductionFraction(row, [row], policy, week), 0);
    });

    it('is zero for a mispunch still inside the free count', () => {
        const row = { date: '2026-10-05', statusKey: 'mispunch' };
        const policy = { missedPunchRule: { events: 2, deduct: 'half' } };
        assert.equal(dayDeductionFraction(row, [row], policy, week), 0);
    });

    it('counts a mispunch that adds a deduction', () => {
        const row = { date: '2026-10-05', statusKey: 'mispunch' };
        const policy = { missedPunchRule: { events: 0, deduct: 'half' } };
        assert.equal(dayDeductionFraction(row, [row], policy, week), 0.5);
    });

    it('is zero after the deduction is already waived', () => {
        const row = { date: '2026-10-05', statusKey: 'authorized_leave', deductionWaived: true };
        assert.equal(dayDeductionFraction(row, [row], { authorizedLeaveDeductionDays: 1 }, week), 0);
    });

    it('drops a missed punch whose loss hours were waived to zero', () => {
        const waived = {
            date: '2026-10-17',
            statusKey: 'mispunch',
            hourAdjustStatus: 'approved',
            hoursApproved: 0,
        };
        const open = { date: '2026-10-24', statusKey: 'mispunch' };
        const policy = { missedPunchRule: { events: 1, deduct: 'half' } };
        assert.equal(dayDeductionFraction(waived, [waived, open], policy, week), 0);
        assert.equal(dayDeductionFraction(open, [waived, open], policy, week), 0);
    });
});
