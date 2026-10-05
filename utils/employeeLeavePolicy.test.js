import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    applyGroupLeavePolicy,
    assertLeaveBalance,
    applySickAllowanceToLeaveRecords,
    buildLeaveBalances,
    buildOffDateSet,
    dateKeysInRange,
    leavePolicyEntitlements,
    sandwichDatesForLeave,
    shiftDateKey,
    splitDatesBySickAllowance,
} from './employeeLeavePolicy.js';

describe('employee leave policy', () => {
    it('uses the group salary policy for leave even when the employee copy differs', () => {
        const applied = applyGroupLeavePolicy(
            {
                authorizedLeaveDeductionDays: 0.5,
                unauthorizedLeaveDeductionDays: 1,
                allowedSickLeaveDaysPerYear: 3,
                processingRules: { sandwichLeave: false, allowedSickLeavePerYear: false, fine: true },
                leaveExclusionEmployeeIds: ['VEGA-OWN'],
            },
            {
                authorizedLeaveDeductionDays: 2,
                unauthorizedLeaveDeductionDays: 0,
                allowedSickLeaveDaysPerYear: 12,
                processingRules: { sandwichLeave: true, allowedSickLeavePerYear: true },
                leaveExclusionEmployeeIds: ['VEGA-GROUP'],
            },
            ['VEGA-GROUP'],
        );
        assert.equal(applied.authorizedLeaveDeductionDays, 2);
        assert.equal(applied.unauthorizedLeaveDeductionDays, 0);
        assert.equal(applied.allowedSickLeaveDaysPerYear, 12);
        assert.equal(applied.processingRules.sandwichLeave, true);
        assert.equal(applied.processingRules.allowedSickLeavePerYear, true);
        assert.equal(applied.processingRules.fine, true);
        assert.deepEqual(applied.leaveExclusionEmployeeIds, ['VEGA-GROUP']);
        assert.equal(leavePolicyEntitlements(applied).sickAllowedDays, 12);
        assert.equal(leavePolicyEntitlements(applied).multipliers.authorized, 2);
    });

    it('uses the group late and missed-punch rules when that policy has a deduct', () => {
        const applied = applyGroupLeavePolicy(
            {
                lateInRules: [{ events: 1, deduct: 'half' }],
                extraLateRules: [],
            },
            {
                lateInRules: [{ events: 4, deduct: 'quarter' }],
                lateOutRules: [{ events: 4, deduct: 'quarter' }],
                extraLateRules: [{ title: 'Missed punch', events: 1, deduct: 'full' }],
            },
            [],
        );
        assert.equal(applied.lateInRules[0].deduct, 'quarter');
        assert.equal(applied.lateInRules[0].events, 4);
        assert.equal(applied.extraLateRules[0].title, 'Missed punch');
        assert.equal(applied.extraLateRules[0].deduct, 'full');
    });

    it('exposes salary-policy allowed sick leave days even when the HR toggle is off', () => {
        const off = leavePolicyEntitlements({
            processingRules: { allowedSickLeavePerYear: false },
            allowedSickLeaveDaysPerYear: 12,
        });
        assert.equal(off.sickEnabled, false);
        assert.equal(off.sickAllowedDays, 12);

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

    it('caps sick leave at 12 days after last annual leave; extra days become authorized', () => {
        const entitlements = leavePolicyEntitlements({
            processingRules: { allowedSickLeavePerYear: true },
            allowedSickLeaveDaysPerYear: 12,
        });
        const sickDates = dateKeysInRange('2026-02-01', '2026-02-13');
        const { types, overflowSickDates } = buildLeaveBalances({
            records: [
                { date: '2026-01-20', statusKey: 'on_leave' },
                { date: '2026-01-21', statusKey: 'on_leave' },
                ...sickDates.map((date) => ({ date, statusKey: 'sick_leave' })),
            ],
            entitlements,
            offSet: new Set(),
            from: '2026-01-01',
            to: '2026-12-31',
            lastAnnualLeaveEnd: '2026-01-21',
        });
        assert.equal(sickDates.length, 13);
        assert.deepEqual(overflowSickDates, ['2026-02-13']);
        assert.equal(types.sick_leave.taken, 12);
        assert.equal(types.sick_leave.remaining, 0);
        assert.equal(types.sick_leave.period, 'from last annual leave to next');
        assert.equal(types.authorized_leave.taken, 1);
    });

    it('resets the 12-day sick allowance after the next annual leave', () => {
        const entitlements = leavePolicyEntitlements({
            processingRules: { allowedSickLeavePerYear: true },
            allowedSickLeaveDaysPerYear: 12,
        });
        const firstCycleSick = dateKeysInRange('2026-02-01', '2026-02-13');
        const { types, overflowSickDates } = buildLeaveBalances({
            records: [
                { date: '2026-01-10', statusKey: 'on_leave' },
                ...firstCycleSick.map((date) => ({ date, statusKey: 'sick_leave' })),
                { date: '2026-06-01', statusKey: 'on_leave' },
                { date: '2026-06-02', statusKey: 'on_leave' },
                { date: '2026-06-10', statusKey: 'sick_leave' },
                { date: '2026-06-11', statusKey: 'sick_leave' },
            ],
            entitlements,
            offSet: new Set(),
            from: '2026-01-01',
            to: '2026-12-31',
            lastAnnualLeaveEnd: '2026-06-02',
            nextAnnualLeaveStart: '',
        });
        assert.deepEqual(overflowSickDates, ['2026-02-13']);
        assert.equal(types.sick_leave.taken, 2);
        assert.equal(types.sick_leave.remaining, 10);
        assert.equal(types.authorized_leave.taken, 1);
    });

    it('does not carry sick days from before last annual leave into the new 12-day cap', () => {
        const entitlements = leavePolicyEntitlements({
            processingRules: { allowedSickLeavePerYear: true },
            allowedSickLeaveDaysPerYear: 12,
        });
        const { types, overflowSickDates } = buildLeaveBalances({
            records: [
                ...dateKeysInRange('2026-01-05', '2026-01-16').map((date) => ({
                    date,
                    statusKey: 'sick_leave',
                })),
                { date: '2026-02-01', statusKey: 'on_leave' },
                { date: '2026-03-02', statusKey: 'sick_leave' },
                { date: '2026-03-03', statusKey: 'sick_leave' },
            ],
            entitlements,
            offSet: new Set(),
            from: '2026-01-01',
            to: '2026-12-31',
            lastAnnualLeaveEnd: '2026-02-01',
        });
        assert.deepEqual(overflowSickDates, []);
        assert.equal(types.sick_leave.taken, 2);
        assert.equal(types.sick_leave.remaining, 10);
    });

    it('splits a sick leave row so days after the 12-day cap become authorized', () => {
        const entitlements = leavePolicyEntitlements({
            processingRules: { allowedSickLeavePerYear: true },
            allowedSickLeaveDaysPerYear: 12,
        });
        const rows = applySickAllowanceToLeaveRecords(
            [
                { leaveType: 'annual', fromDate: '2026-01-10', toDate: '2026-01-15' },
                { leaveType: 'sick', fromDate: '2026-02-01', toDate: '2026-02-14' },
            ],
            entitlements,
            { lastAnnualLeaveEnd: '2026-01-15' },
        );
        const sick = rows.filter((row) => row.leaveType === 'sick');
        const authorized = rows.filter((row) => row.leaveType === 'authorized');
        assert.equal(sick.length, 1);
        assert.equal(sick[0].fromDate, '2026-02-01');
        assert.equal(sick[0].toDate, '2026-02-12');
        assert.equal(authorized.length, 1);
        assert.equal(authorized[0].fromDate, '2026-02-13');
        assert.equal(authorized[0].toDate, '2026-02-14');
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
