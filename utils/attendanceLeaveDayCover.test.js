import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    applyLeaveCoverIndex,
    chooseLeaveCover,
    coverKey,
    enrollmentCoveredDateSet,
    enrollmentCoverIndexForEmployee,
    isAbsentAttendanceDay,
    omitUnauthorizedLeaveOnDates,
} from './attendanceLeaveDayCover.js';

const annualCover = {
    employeeMongoId: 'emp-1',
    employeeId: 'VEGA-HR-00033',
    employeeName: 'MELVIN SHIJO THARSIS',
    date: '2026-10-02',
    statusKey: 'on_leave',
    statusLabel: 'Annual Leave',
    leaveRequestStatus: 'approved',
    requestedStatusKey: 'on_leave',
    requestedStatusLabel: 'Annual Leave',
    leaveRequestFromDate: '2026-10-01',
    leaveRequestToDate: '2026-10-10',
    reason: '',
    source: 'enrollment',
    isPending: false,
    historical: true,
};

describe('attendance leave day cover', () => {
    it('shows annual leave instead of an auto unauthorized day', () => {
        const index = new Map([[coverKey('emp-1', '2026-10-02'), annualCover]]);
        const [row] = applyLeaveCoverIndex(
            [
                {
                    _id: 'att-1',
                    date: '2026-10-02',
                    employeeMongoId: 'emp-1',
                    statusKey: 'unauthorized_leave',
                    statusLabel: 'Unauthorized Leave',
                    reason: 'No punch-in or punch-out (auto at midnight)',
                    timeIn: '',
                    timeOut: '',
                },
            ],
            index,
        );
        assert.equal(row.statusKey, 'on_leave');
        assert.equal(row.statusLabel, 'Annual Leave');
        assert.equal(row.reason, '');
        assert.equal(row.leaveRequestStatus, 'approved');
        assert.equal(row._id, 'att-1');
    });

    it('shows annual leave for today when no attendance row exists', () => {
        const today = { ...annualCover, date: '2026-10-03' };
        const index = new Map([[coverKey('emp-1', '2026-10-03'), today]]);
        const [row] = applyLeaveCoverIndex([], index);
        assert.equal(row.employeeMongoId, 'emp-1');
        assert.equal(row.date, '2026-10-03');
        assert.equal(row.statusKey, 'on_leave');
        assert.equal(row.statusLabel, 'Annual Leave');
        assert.equal(isAbsentAttendanceDay(null), true);
    });

    it('keeps a punched present day', () => {
        const index = new Map([[coverKey('emp-1', '2026-10-02'), annualCover]]);
        const [row] = applyLeaveCoverIndex(
            [
                {
                    date: '2026-10-02',
                    employeeMongoId: 'emp-1',
                    statusKey: 'on_office',
                    statusLabel: 'Present',
                    timeIn: '09:00:00',
                    timeOut: '18:00:00',
                },
            ],
            index,
        );
        assert.equal(row.statusKey, 'on_office');
        assert.equal(row.timeIn, '09:00:00');
    });

    it('uses a pending annual request on an unauthorized row', () => {
        const [row] = applyLeaveCoverIndex(
            [
                {
                    date: '2026-10-02',
                    employeeMongoId: 'emp-1',
                    statusKey: 'unauthorized_leave',
                    statusLabel: 'Unauthorized Leave',
                    reason: 'No punch-in or punch-out (auto at midnight)',
                    leaveRequestStatus: 'pending',
                    requestedStatusKey: 'on_leave',
                    requestedStatusLabel: 'Annual Leave',
                    leaveRequestReason: 'Travel',
                    leaveRequestFromDate: '2026-10-02',
                    leaveRequestToDate: '2026-10-04',
                },
            ],
            new Map(),
        );
        assert.equal(row.statusKey, 'on_leave');
        assert.equal(row.leaveRequestStatus, 'pending');
        assert.equal(row.reason, 'Travel');
    });

    it('prefers approved attendance leave over salary enrollment', () => {
        const chosen = chooseLeaveCover(annualCover, {
            ...annualCover,
            source: 'scheduled',
            statusKey: 'sick_leave',
            isPending: false,
        });
        assert.equal(chosen.source, 'scheduled');
        assert.equal(chosen.statusKey, 'sick_leave');
        const pending = chooseLeaveCover(
            { ...annualCover, source: 'scheduled', isPending: true },
            annualCover,
        );
        assert.equal(pending.isPending, true);
    });

    it('does not replace a weekly off', () => {
        const index = new Map([[coverKey('emp-1', '2026-10-02'), annualCover]]);
        const [row] = applyLeaveCoverIndex(
            [
                {
                    date: '2026-10-02',
                    employeeMongoId: 'emp-1',
                    statusKey: 'weekly_off',
                    statusLabel: 'Off Day',
                },
            ],
            index,
            { fillMissing: false },
        );
        assert.equal(row.statusKey, 'weekly_off');
    });

    it('maps enrollment annual dates and drops unauthorized salary days on them', () => {
        const profile = {
            annualLeaveRecords: [
                {
                    _id: 'ann-1',
                    startDate: '2026-10-01',
                    endDate: '2026-10-03',
                    source: 'manual',
                    status: 'verified',
                },
            ],
        };
        const employee = { _id: 'emp-1', employeeId: 'VEGA-HR-00033', firstName: 'MELVIN', lastName: 'THARSIS' };
        const dates = enrollmentCoveredDateSet(profile, '2026-10-01', '2026-10-31');
        assert.equal(dates.has('2026-10-02'), true);
        assert.equal(dates.has('2026-10-04'), false);
        const index = enrollmentCoverIndexForEmployee(profile, employee, '2026-10-01', '2026-10-03');
        assert.equal(index.get(coverKey('emp-1', '2026-10-03'))?.statusKey, 'on_leave');
        const leave = omitUnauthorizedLeaveOnDates(
            [
                { leaveType: 'unauthorized', fromDate: '2026-10-02', source: 'system' },
                { leaveType: 'unauthorized', fromDate: '2026-10-04', source: 'system' },
                { leaveType: 'sick', fromDate: '2026-10-02', source: 'system' },
            ],
            dates,
        );
        assert.deepEqual(
            leave.map((row) => `${row.leaveType}:${row.fromDate}`),
            ['unauthorized:2026-10-04', 'sick:2026-10-02'],
        );
    });
});
