import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildLeaveEntitlementCalculation } from './leaveEntitlementAllocation.js';

function annual(from, to, extra = {}) {
    return {
        leaveType: 'annual',
        fromDate: from,
        toDate: to,
        status: 'approved',
        ...extra,
    };
}

describe('leave entitlement allocation', () => {
    it('allocates the sample leaves, keeps 5 days excess, and does not treat all of leave 2 as allocated', () => {
        const result = buildLeaveEntitlementCalculation({
            joiningDate: '2024-10-11',
            asOf: '2026-11-02',
            leaveRecords: [
                annual('2025-03-24', '2025-04-26'),
                annual('2026-07-13', '2026-09-11'),
            ],
        });

        assert.equal(result.ok, true);
        assert.equal(result.cycles.length, 3);
        assert.deepEqual(
            result.cycles.map((cycle) => [cycle.startDate, cycle.endDate]),
            [
                ['2024-10-11', '2025-10-10'],
                ['2025-10-11', '2026-10-10'],
                ['2026-10-11', '2027-10-10'],
            ],
        );
        assert.deepEqual(result.cycles.map((cycle) => cycle.entitlement), [30, 30, 30]);
        assert.equal(result.leaves[0].days, 34);
        assert.deepEqual(result.leaves[0].allocations, [30, 4, 0]);
        assert.deepEqual(result.leaves[0].advance, [0, 4, 0]);
        assert.equal(result.leaves[1].days, 61);
        assert.deepEqual(result.leaves[1].allocations, [0, 26, 30]);
        assert.deepEqual(result.leaves[1].advance, [0, 0, 30]);
        assert.equal(result.leaves[1].allocated, 56);
        assert.equal(result.leaves[1].excess, 5);
        assert.deepEqual(result.cycles.map((cycle) => cycle.deducted), [30, 30, 30]);
        assert.deepEqual(result.cycles.map((cycle) => cycle.remaining), [0, 0, 0]);
        assert.equal(result.totalEntitlement, 90);
        assert.equal(result.totalLeaveTaken, 95);
        assert.equal(result.totalDeducted, 90);
        assert.equal(result.excessLeave, 5);
        assert.equal(result.totalLeaveTaken, result.totalDeducted + result.excessLeave);
    });

    it('uses unused entitlement in the next cycle only', () => {
        const result = buildLeaveEntitlementCalculation({
            joiningDate: '2024-01-01',
            asOf: '2026-06-15',
            leaveRecords: [
                annual('2024-06-01', '2024-06-10'),
                annual('2025-03-01', '2025-04-09'),
            ],
        });

        assert.equal(result.leaves[0].days, 10);
        assert.equal(result.leaves[1].days, 40);
        assert.deepEqual(result.leaves[0].allocations, [10, 0, 0]);
        assert.deepEqual(result.leaves[1].allocations, [20, 20, 0]);
        assert.equal(result.leaves[1].advance.reduce((sum, days) => sum + days, 0), 0);
        assert.deepEqual(result.cycles.map((cycle) => cycle.deducted), [30, 20, 0]);
        assert.deepEqual(result.cycles.map((cycle) => cycle.remaining), [0, 10, 30]);
        assert.equal(result.excessLeave, 0);
        assert.equal(result.expiredLeave, 0);
    });

    it('expires unused entitlement after the following cycle and will not spend it later', () => {
        const result = buildLeaveEntitlementCalculation({
            joiningDate: '2024-01-01',
            asOf: '2026-06-15',
            leaveRecords: [
                annual('2024-06-01', '2024-06-10'),
                annual('2026-02-01', '2026-02-10'),
            ],
        });

        assert.deepEqual(result.leaves[1].allocations, [0, 10, 0]);
        assert.equal(result.cycles[0].deducted, 10);
        assert.equal(result.cycles[0].expired, 20);
        assert.equal(result.cycles[0].remaining, 0);
        assert.equal(result.cycles[1].deducted, 10);
        assert.equal(result.cycles[1].remaining, 20);
        assert.equal(result.cycles[2].deducted, 0);
        assert.equal(result.cycles[2].remaining, 30);
        assert.equal(result.expiredLeave, 20);
        assert.equal(result.excessLeave, 0);
    });

    it('borrows only the next cycle and records the rest as excess', () => {
        const result = buildLeaveEntitlementCalculation({
            joiningDate: '2024-10-11',
            asOf: '2025-06-01',
            leaveRecords: [annual('2025-03-01', '2025-05-09')],
        });

        assert.equal(result.leaves[0].days, 70);
        assert.equal(result.cycles.length, 2);
        assert.deepEqual(result.leaves[0].allocations, [30, 30]);
        assert.deepEqual(result.leaves[0].advance, [0, 30]);
        assert.equal(result.leaves[0].excess, 10);
        assert.equal(result.totalEntitlement, 60);
        assert.equal(result.totalDeducted, 60);
        assert.equal(result.excessLeave, 10);
        assert.equal(result.advanceDays, 30);
    });

    it('does not deduct pending, rejected, cancelled, or draft leave', () => {
        const counted = annual('2025-03-24', '2025-04-26');
        const result = buildLeaveEntitlementCalculation({
            joiningDate: '2024-10-11',
            asOf: '2026-11-02',
            leaveRecords: [
                counted,
                annual('2025-05-01', '2025-05-10', { status: 'pending' }),
                annual('2025-06-01', '2025-06-05', { status: 'rejected' }),
                annual('2025-07-01', '2025-07-03', { status: 'cancelled' }),
                annual('2025-08-01', '2025-08-02', { status: 'draft' }),
                annual('2025-01-02', '2025-01-03', { status: 'Approved' }),
            ],
        });

        assert.equal(result.totalLeaveTaken, 34 + 2);
        assert.equal(result.skippedPendingDays, 10);
        assert.ok(result.skippedRejectedDays >= 5);
        assert.equal(result.leaves.some((leave) => leave.startDate === '2025-05-01'), false);
        assert.equal(result.leaves.some((leave) => leave.startDate === '2025-01-02'), true);
    });

    it('flags approved leave taken before first eligibility without dropping it', () => {
        const result = buildLeaveEntitlementCalculation({
            joiningDate: '2024-10-11',
            asOf: '2026-11-02',
            firstEligibilityDate: '2025-10-10',
            leaveRecords: [
                annual('2025-03-24', '2025-04-26'),
                annual('2026-07-13', '2026-09-11', { status: 'pending' }),
            ],
        });

        assert.equal(result.leaves.length, 1);
        assert.equal(result.leaves[0].beforeFirstEligibility, true);
        assert.equal(result.leaves[0].days, 34);
        assert.equal(result.totalLeaveTaken, 34);
        assert.equal(result.skippedPendingDays, 61);
    });

    it('deducts overlapping and repeated transactions once', () => {
        const row = annual('2025-03-24', '2025-04-26', { id: 'leave-a' });
        const records = [row, { ...row }, annual('2025-04-01', '2025-04-10', { id: 'inside' })];
        const first = buildLeaveEntitlementCalculation({
            joiningDate: '2024-10-11',
            asOf: '2026-11-02',
            leaveRecords: records,
        });
        const second = buildLeaveEntitlementCalculation({
            joiningDate: '2024-10-11',
            asOf: '2026-11-02',
            leaveRecords: records,
        });

        assert.equal(first.leaves.length, 1);
        assert.equal(first.totalLeaveTaken, 34);
        assert.equal(first.excessLeave, second.excessLeave);
        assert.deepEqual(first.cycles.map((cycle) => cycle.deducted), second.cycles.map((cycle) => cycle.deducted));
        assert.equal(records.length, 3);
        assert.equal(records[0].fromDate, '2025-03-24');
        assert.equal(row.toDate, '2025-04-26');
    });

    it('merges contiguous system days into one leave and keeps separate manual days', () => {
        const systemDays = ['2025-03-24', '2025-03-25', '2025-03-26'].map((date) =>
            annual(date, date, { source: 'system' }),
        );
        const merged = buildLeaveEntitlementCalculation({
            joiningDate: '2024-10-11',
            asOf: '2025-06-01',
            leaveRecords: systemDays,
        });
        assert.equal(merged.leaves.length, 1);
        assert.equal(merged.leaves[0].days, 3);
        assert.equal(merged.leaves[0].startDate, '2025-03-24');
        assert.equal(merged.leaves[0].endDate, '2025-03-26');

        const manual = buildLeaveEntitlementCalculation({
            joiningDate: '2024-10-11',
            asOf: '2025-06-01',
            leaveRecords: [annual('2025-03-24', '2025-03-24'), annual('2025-03-25', '2025-03-25')],
        });
        assert.equal(manual.leaves.length, 2);
    });

    it('ignores other leave types and a lower saved day count cannot exceed the calendar span', () => {
        const result = buildLeaveEntitlementCalculation({
            joiningDate: '2024-10-11',
            asOf: '2025-06-01',
            leaveRecords: [
                { leaveType: 'sick', fromDate: '2025-01-01', toDate: '2025-01-10', status: 'approved' },
                annual('2025-03-24', '2025-04-26', { eligibleWorkingDays: 10 }),
            ],
        });
        assert.equal(result.leaves.length, 1);
        assert.equal(result.leaves[0].days, 10);
        assert.equal(result.totalLeaveTaken, 10);
    });

    it('recalculates allocation when a leave length is overridden', () => {
        const result = buildLeaveEntitlementCalculation({
            joiningDate: '2024-10-11',
            asOf: '2026-11-02',
            leaveRecords: [
                annual('2025-03-24', '2025-04-26', { id: 'leave-1' }),
                annual('2026-07-13', '2026-09-11', { id: 'leave-2' }),
            ],
            dayOverrides: { 'leave-1': 40 },
        });

        assert.equal(result.leaves[0].days, 40);
        assert.deepEqual(result.leaves[0].allocations, [30, 10, 0]);
        assert.equal(result.leaves[0].excess, 0);
        assert.equal(result.leaves[1].days, 61);
        assert.deepEqual(result.leaves[1].allocations, [0, 20, 30]);
        assert.equal(result.leaves[1].excess, 11);
        assert.equal(result.totalLeaveTaken, 101);
        assert.equal(result.totalEntitlement, 90);
        assert.equal(result.excessLeave, 11);
        assert.deepEqual(result.cycles.map((cycle) => cycle.remaining), [0, 0, 0]);
    });

    it('returns an empty calculation when the joining date is missing', () => {
        const result = buildLeaveEntitlementCalculation({
            asOf: '2026-11-02',
            leaveRecords: [annual('2025-03-24', '2025-04-26')],
        });
        assert.equal(result.ok, false);
        assert.equal(result.totalEntitlement, 0);
        assert.equal(result.totalLeaveTaken, 0);
        assert.equal(result.cycles.length, 0);
    });
});
