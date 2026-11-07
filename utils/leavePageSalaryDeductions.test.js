import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { overlaySuspendedAttendance } from './attendanceSuspension.js';
import {
    leaveDeductionCountWindow,
    shownDeductionKind,
    summarizeLeavePageDeductions,
} from './leavePageSalaryDeductions.js';

describe('leave page salary deductions', () => {
    it('counts an approved annual request as annual leave, not unauthorized leave', () => {
        const row = {
            date: '2026-10-05',
            statusKey: 'unauthorized_leave',
            leaveRequestStatus: 'approved',
            requestedStatusKey: 'on_leave',
        };
        assert.equal(shownDeductionKind(row), 'on_leave');
        const summary = summarizeLeavePageDeductions({
            records: [row],
            daily: 80,
            from: '2026-10-01',
            to: '2026-10-31',
            unauthTimes: 2,
        });
        assert.equal(summary.unauthorized.days, 0);
        assert.equal(summary.unauthorized.amount, 0);
        assert.equal(summary.annual.days, 1);
        assert.equal(summary.annual.amount, 80);
    });

    it('keeps a real unauthorized day at the unauthorized rate', () => {
        const summary = summarizeLeavePageDeductions({
            records: [{ date: '2026-10-05', statusKey: 'unauthorized_leave' }],
            daily: 80,
            from: '2026-10-01',
            to: '2026-10-31',
            unauthTimes: 2,
        });
        assert.equal(summary.unauthorized.days, 1);
        assert.equal(summary.unauthorized.amount, 160);
    });

    it('shows sandwich leave as 0 when no weekly off sits between leave', () => {
        const summary = summarizeLeavePageDeductions({
            records: [{ date: '2026-10-05', statusKey: 'on_office', timeIn: '09:00', timeOut: '18:00' }],
            daily: 80,
            from: '2026-10-01',
            to: '2026-10-31',
            offWeekdays: new Set(['friday']),
        });
        assert.equal(summary.sandwich.days, 0);
        assert.equal(summary.sandwich.amount, 0);
        assert.equal(summary.lateIn.count, 0);
        assert.equal(summary.lateIn.amount, 0);
    });

    it('deducts one day for a weekly off between two leave days', () => {
        const summary = summarizeLeavePageDeductions({
            records: [
                { date: '2026-10-01', statusKey: 'on_leave' },
                { date: '2026-10-03', statusKey: 'on_leave' },
            ],
            daily: 80,
            from: '2026-10-01',
            to: '2026-10-31',
            offWeekdays: new Set(['friday']),
        });
        assert.equal(summary.sandwich.days, 1);
        assert.equal(summary.sandwich.amount, 80);
        assert.equal(summary.annual.days, 2);
        assert.equal(summary.annual.amount, 160);
    });

    it('does not deduct suspended days as unauthorized leave or sandwich leave', () => {
        const employee = {
            attendanceAccountStatus: 'suspended',
            attendanceSuspension: {
                fromDate: '2026-10-08',
                untilDate: '2026-10-20',
                description: 'Hold',
            },
        };
        const stored = [
            { date: '2026-10-05', statusKey: 'authorized_leave' },
            { date: '2026-10-07', statusKey: 'late_arrived', timeIn: '10:30', timeOut: '18:00' },
            { date: '2026-10-08', statusKey: 'unauthorized_leave' },
            { date: '2026-10-10', statusKey: 'unauthorized_leave' },
            { date: '2026-10-12', statusKey: 'not_marked' },
            { date: '2026-10-13', statusKey: 'on_office', timeIn: '09:00', timeOut: '18:00' },
        ];
        const shown = overlaySuspendedAttendance(stored, employee, '2026-10-01', '2026-10-31');
        assert.equal(shownDeductionKind(shown.find((row) => row.date === '2026-10-08')), 'suspended');
        const summary = summarizeLeavePageDeductions({
            records: shown,
            daily: 80,
            from: '2026-10-01',
            to: '2026-10-31',
            authTimes: 1,
            unauthTimes: 2,
            offWeekdays: new Set(['friday']),
        });
        assert.equal(summary.unauthorized.days, 0);
        assert.equal(summary.unauthorized.amount, 0);
        assert.equal(summary.sandwich.days, 0);
        assert.equal(summary.sandwich.amount, 0);
        assert.equal(summary.authorized.days, 1);
        assert.equal(summary.authorized.amount, 80);
        assert.equal(summary.lateIn.count, 1);
    });

    it('counts the current month only through yesterday', () => {
        assert.deepEqual(
            leaveDeductionCountWindow({
                monthKey: '2026-11',
                todayKey: '2026-11-07',
            }),
            { from: '2026-11-01', to: '2026-11-06' },
        );
        assert.deepEqual(
            leaveDeductionCountWindow({
                monthKey: '2026-10',
                todayKey: '2026-11-07',
            }),
            { from: '2026-10-01', to: '2026-10-31' },
        );
    });
});
