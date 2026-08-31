import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    assertLeaveBalance,
    buildLeaveBalances,
    buildOffDateSet,
    dateKeysInRange,
    leavePolicyEntitlements,
    sandwichDatesForLeave,
    shiftDateKey,
    splitDatesBySickAllowance,
} from './employeeLeavePolicy.js';

describe('employee leave policy', () => {
    it('uses allowed sick leave per year only when the HR rule is enabled', () => {
        const off = leavePolicyEntitlements({
            processingRules: { allowedSickLeavePerYear: false },
            allowedSickLeaveDaysPerYear: 12,
        });
        assert.equal(off.sickEnabled, false);
        assert.equal(off.sickAllowedDays, null);

        const on = leavePolicyEntitlements({
            processingRules: { allowedSickLeavePerYear: true },
            allowedSickLeaveDaysPerYear: 12,
            authorizedLeaveDeductionDays: 0.5,
            unauthorizedLeaveDeductionDays: 2,
        });
        assert.equal(on.sickEnabled, true);
        assert.equal(on.sickAllowedDays, 12);
        assert.equal(on.multipliers.authorized, 0.5);
        assert.equal(on.multipliers.unauthorized, 2);
    });

    it('counts weekend/holiday sandwich days between leave', () => {
        const leaveByDate = new Map([
            ['2026-08-07', 'sick_leave'],
            ['2026-08-10', 'sick_leave'],
        ]);
        const offSet = buildOffDateSet({
            from: '2026-08-01',
            to: '2026-08-15',
            offWeekdays: ['saturday', 'sunday'],
            holidaySet: new Set(),
        });
        assert.equal(offSet.has('2026-08-08'), true);
        assert.equal(offSet.has('2026-08-09'), true);
        const extras = sandwichDatesForLeave({
            leaveByDate,
            offSet,
            from: '2026-08-01',
            to: '2026-08-15',
        });
        assert.deepEqual(
            extras.map((row) => row.date).sort(),
            ['2026-08-08', '2026-08-09'],
        );
        assert.ok(extras.every((row) => row.statusKey === 'sick_leave'));
    });

    it('does not sandwich an off day next to present attendance', () => {
        const leaveByDate = new Map([['2026-08-06', 'on_leave']]);
        const extras = sandwichDatesForLeave({
            leaveByDate,
            offSet: new Set(['2026-08-07', '2026-08-08']),
            from: '2026-08-01',
            to: '2026-08-15',
        });
        assert.equal(extras.length, 0);
    });

    it('builds remaining sick/annual balances from policy and sandwich days', () => {
        const entitlements = leavePolicyEntitlements({
            processingRules: { allowedSickLeavePerYear: true, sandwichLeave: true },
            allowedSickLeaveDaysPerYear: 5,
            authorizedLeaveDeductionDays: 1,
            unauthorizedLeaveDeductionDays: 2,
        });
        const { types, sandwichRows } = buildLeaveBalances({
            records: [
                { date: '2026-08-06', statusKey: 'sick_leave' },
                { date: '2026-08-09', statusKey: 'sick_leave' },
                { date: '2026-08-10', statusKey: 'on_leave' },
                { date: '2026-08-11', statusKey: 'unauthorized_leave' },
                {
                    date: '2026-08-12',
                    statusKey: 'on_office',
                    leaveRequestStatus: 'pending',
                    requestedStatusKey: 'on_leave',
                },
            ],
            entitlements,
            offSet: new Set(['2026-08-07', '2026-08-08']),
            from: '2026-08-01',
            to: '2026-08-31',
        });
        assert.equal(sandwichRows.length, 2);
        assert.equal(types.sick_leave.taken, 4);
        assert.equal(types.sick_leave.remaining, 1);
        assert.equal(types.on_leave.taken, 1);
        assert.equal(types.on_leave.pending, 1);
        assert.equal(types.on_leave.remaining, 29);
        assert.equal(types.unauthorized_leave.deductionDays, 2);
        assert.equal(types.unauthorized_leave.allowed, null);
    });

    it('counts extra sick days as authorized leave once the yearly allowance is used', () => {
        const entitlements = leavePolicyEntitlements({
            processingRules: { allowedSickLeavePerYear: true },
            allowedSickLeaveDaysPerYear: 2,
            authorizedLeaveDeductionDays: 1,
            unauthorizedLeaveDeductionDays: 2,
        });
        const { types, overflowSickDates } = buildLeaveBalances({
            records: [
                { date: '2026-08-03', statusKey: 'sick_leave' },
                { date: '2026-08-04', statusKey: 'sick_leave' },
                { date: '2026-08-05', statusKey: 'sick_leave' },
                { date: '2026-08-06', statusKey: 'authorized_leave' },
            ],
            entitlements,
            offSet: new Set(),
            from: '2026-08-01',
            to: '2026-08-31',
        });
        assert.deepEqual(overflowSickDates, ['2026-08-05']);
        assert.equal(types.sick_leave.taken, 2);
        assert.equal(types.sick_leave.remaining, 0);
        assert.equal(types.authorized_leave.taken, 2);
        assert.equal(
            splitDatesBySickAllowance(['2026-08-10', '2026-08-11'], {
                taken: 2,
                allowed: 2,
                enabled: true,
            }).authorizedDates.join(','),
            '2026-08-10,2026-08-11',
        );
    });

    it('does not block extra sick leave; overflow becomes authorized instead', () => {
        assert.equal(
            assertLeaveBalance({
                statusKey: 'sick_leave',
                extraDays: 4,
                balances: { sick_leave: { taken: 2, pending: 0, allowed: 2 } },
            }),
            '',
        );
        const message = assertLeaveBalance({
            statusKey: 'on_leave',
            extraDays: 2,
            balances: { on_leave: { taken: 29, pending: 0, allowed: 30 } },
        });
        assert.match(message, /Annual leave exceeds/);
        assert.equal(
            assertLeaveBalance({
                statusKey: 'authorized_leave',
                extraDays: 10,
                balances: { authorized_leave: { taken: 2, pending: 0, allowed: null } },
            }),
            '',
        );
    });

    it('walks inclusive date keys', () => {
        assert.equal(shiftDateKey('2026-08-31', 1), '2026-09-01');
        assert.deepEqual(dateKeysInRange('2026-08-30', '2026-09-01'), [
            '2026-08-30',
            '2026-08-31',
            '2026-09-01',
        ]);
    });
});
