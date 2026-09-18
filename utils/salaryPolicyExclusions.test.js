import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    applySalarySlipCountExclusions,
    employeeIdInList,
    mergeEmployeeIdLists,
    normalizeEmployeeIdList,
    salarySlipPolicyExclusions,
    shouldHideSalarySlipDeduction,
    shouldHideSalarySlipEarning,
} from './salaryPolicyExclusions.js';

describe('salary policy employee exclusions', () => {
    it('normalizes employee ids and matches selected people', () => {
        assert.deepEqual(normalizeEmployeeIdList([' VEGA-001 ', 'vega-001', '', 'VEGA-002']), [
            'VEGA-001',
            'VEGA-002',
        ]);
        assert.equal(employeeIdInList('vega-001', ['VEGA-001', 'VEGA-002']), true);
        assert.equal(employeeIdInList('VEGA-009', ['VEGA-001']), false);
        assert.deepEqual(mergeEmployeeIdLists(['VEGA-001'], ['vega-001', 'VEGA-003']), [
            'VEGA-001',
            'VEGA-003',
        ]);
    });

    it('flags leave and attendance exclusions from salary policy lists', () => {
        const policy = {
            attendanceExclusionEmployeeIds: ['VEGA-010'],
            leaveExclusionEmployeeIds: ['VEGA-011'],
        };
        assert.deepEqual(salarySlipPolicyExclusions('VEGA-010', policy), {
            attendance: true,
            leave: false,
        });
        assert.deepEqual(salarySlipPolicyExclusions('VEGA-011', policy), {
            attendance: false,
            leave: true,
        });
        assert.deepEqual(salarySlipPolicyExclusions('VEGA-012', policy), {
            attendance: false,
            leave: false,
        });
    });

    it('hides taken-leave rows, not leave salary, and full-salary attendance extras', () => {
        const leaveOnly = { leave: true, attendance: false };
        const attendanceOnly = { leave: false, attendance: true };
        assert.equal(shouldHideSalarySlipDeduction('Authorized Leave', leaveOnly), true);
        assert.equal(shouldHideSalarySlipDeduction('Sick Leave', leaveOnly), true);
        assert.equal(shouldHideSalarySlipDeduction('Late Arrival', leaveOnly), false);
        assert.equal(shouldHideSalarySlipDeduction('Loan', leaveOnly), false);
        assert.equal(shouldHideSalarySlipDeduction('Leave Salary', leaveOnly), false);
        assert.equal(shouldHideSalarySlipDeduction('Late Arrival', attendanceOnly), true);
        assert.equal(shouldHideSalarySlipDeduction('Unauthorized Leave', attendanceOnly), true);
        assert.equal(shouldHideSalarySlipDeduction('Fine', attendanceOnly), false);
        assert.equal(shouldHideSalarySlipEarning('Overtime Hours', attendanceOnly), true);
        assert.equal(shouldHideSalarySlipEarning('Reward', attendanceOnly), false);
        assert.equal(shouldHideSalarySlipEarning('Overtime Days', leaveOnly), false);
    });

    it('clears leave counts for leave exclusion and attendance pay for attendance exclusion', () => {
        const counted = {
            workingDayLeaves: 3,
            authorizedDays: 1,
            unauthorizedDays: 1,
            sickDays: 1,
            unpaidSickDays: 1,
            annualDays: 2,
            compOffDays: 1,
            lateEvents: 4,
            holidaysWorked: 1,
            otHours: 5,
            otDays: 1,
            presentDays: 20,
        };
        assert.deepEqual(applySalarySlipCountExclusions(counted, { leave: true }), {
            ...counted,
            workingDayLeaves: 0,
            authorizedDays: 0,
            unauthorizedDays: 0,
            sickDays: 0,
            unpaidSickDays: 0,
            annualDays: 0,
            compOffDays: 0,
        });
        assert.deepEqual(applySalarySlipCountExclusions(counted, { attendance: true }), {
            ...counted,
            workingDayLeaves: 0,
            authorizedDays: 0,
            unauthorizedDays: 0,
            sickDays: 0,
            unpaidSickDays: 0,
            annualDays: 0,
            compOffDays: 0,
            lateEvents: 0,
            holidaysWorked: 0,
            otHours: 0,
            otDays: 0,
        });
    });
});
