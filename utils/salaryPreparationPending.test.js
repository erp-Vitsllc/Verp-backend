import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    buildSalaryPreparationPending,
    hiddenByReassignedLeave,
    leaveCardMatchesOpenRequest,
} from './salaryPreparationPending.js';

const todayKey = '2026-10-15';
const year = { yearFrom: '2026-01-01', yearTo: '2026-12-31', todayKey, reportsTo: 'HR Manager', hrName: 'Sara HR', staffType: 'office' };

describe('buildSalaryPreparationPending', () => {
    it('lists authorize leave and groups a multi-day request once', () => {
        const items = buildSalaryPreparationPending({
            ...year,
            attendanceRows: [
                {
                    _id: 'a1',
                    date: '2026-10-21',
                    employeeMongoId: 'emp',
                    leaveRequestStatus: 'pending',
                    leaveRequestKind: 'future_leave',
                    requestedStatusKey: 'authorized_leave',
                    leaveRequestGroupId: 'group-1',
                    leaveRequestFromDate: '2026-10-21',
                    leaveRequestToDate: '2026-10-22',
                    leaveRequestedAt: '2026-10-14',
                },
                {
                    _id: 'a2',
                    date: '2026-10-22',
                    employeeMongoId: 'emp',
                    leaveRequestStatus: 'pending',
                    leaveRequestKind: 'future_leave',
                    requestedStatusKey: 'authorized_leave',
                    leaveRequestGroupId: 'group-1',
                    leaveRequestFromDate: '2026-10-21',
                    leaveRequestToDate: '2026-10-22',
                    leaveRequestedAt: '2026-10-14',
                },
            ],
        });
        assert.equal(items.length, 1);
        assert.equal(items[0].title, 'Authorized leave request');
        assert.equal(items[0].subtitle, '21-22 Oct - 2 days');
        assert.equal(items[0].owner, 'HR Manager');
        assert.match(items[0].href, /approvalId=a1/);
        assert.match(items[0].href, /employeeId=emp/);
        assert.equal(items[0].fromDate, '2026-10-21');
        assert.equal(items[0].dateLabel, '21 Oct 2026');
        assert.equal(items[0].spanAllMonths, true);
    });

    it('includes attendance leave, late, hour, and overtime requests', () => {
        const items = buildSalaryPreparationPending({
            ...year,
            attendanceRows: [
                {
                    _id: 'y1',
                    date: '2026-10-14',
                    employeeMongoId: 'emp',
                    leaveRequestStatus: 'pending',
                    leaveRequestKind: 'yellow',
                    requestedStatusKey: 'on_office',
                    leaveRequestedAt: '2026-10-14',
                },
                {
                    _id: 'h1',
                    date: '2026-10-10',
                    employeeMongoId: 'emp',
                    hourAdjustStatus: 'pending',
                    hoursApproved: 2,
                    createdAt: '2026-10-10',
                },
                {
                    _id: 'o1',
                    date: '2026-10-09',
                    employeeMongoId: 'emp',
                    flexibleOtStatus: 'pending',
                    flexibleOtApprovedHours: 3,
                    createdAt: '2026-10-09',
                },
            ],
            changeRows: [
                {
                    _id: 'c1',
                    date: '2026-10-11',
                    employeeMongoId: 'emp',
                    stage: 'pending_hr',
                    action: 'flexible_ot',
                    hrName: 'Sara HR',
                    proposed: { statusLabel: 'Apply OT 5 hr' },
                    createdAt: '2026-10-11',
                },
                {
                    _id: 'c2',
                    date: '2026-10-10',
                    employeeMongoId: 'emp',
                    stage: 'pending_reportee',
                    action: 'hour_adjust',
                    reporteeName: 'Team Lead',
                    proposed: { statusLabel: 'Hour approval 2 hr' },
                    createdAt: '2026-10-12',
                },
            ],
        });
        const titles = items.map((row) => row.title);
        assert.deepEqual(titles, [
            'Attendance Leave Request',
            'Hour Approval Request',
            'Attendance Change Request',
            'Flexible OT Request',
        ]);
        const ot = items.find((row) => row.id === 'change-c1');
        assert.equal(ot.subtitle, 'Apply OT 5 hr');
        assert.equal(ot.status, 'Waiting for HR');
        assert.equal(ot.owner, 'Sara HR');
        assert.match(ot.href, /changeRequestId=c1/);
        const hour = items.find((row) => row.id === 'change-c2');
        assert.equal(hour.owner, 'Team Lead');
        assert.equal(hour.status, 'Waiting for primary reportee');
        assert.equal(items.some((row) => row.id === 'hour-h1'), false);
    });

    it('drops requests outside the profile year', () => {
        const items = buildSalaryPreparationPending({
            ...year,
            attendanceRows: [
                {
                    _id: 'old',
                    date: '2025-12-01',
                    leaveRequestStatus: 'pending',
                    leaveRequestKind: 'future_leave',
                    requestedStatusKey: 'authorized_leave',
                    leaveRequestFromDate: '2025-12-01',
                    leaveRequestToDate: '2025-12-01',
                },
            ],
        });
        assert.equal(items.length, 0);
    });

    it('keeps a task card only when this employee still has that request open', () => {
        const openLeave = {
            _id: 'att-1',
            date: '2026-10-21',
            leaveRequestStatus: 'pending',
            leaveRequestFromDate: '2026-10-21',
            leaveRequestToDate: '2026-10-21',
            leaveRequestGroupId: 'group-1',
        };
        const openPunch = { _id: 'chg-1', date: '2026-10-12', stage: 'pending_reportee' };
        assert.equal(leaveCardMatchesOpenRequest(
            { requestId: 'group-1', fromDate: '2026-10-21', toDate: '2026-10-21' },
            { attendanceRows: [openLeave], changeRows: [] },
        ), true);
        assert.equal(leaveCardMatchesOpenRequest(
            { requestId: 'old-task', fromDate: '2026-10-21', toDate: '2026-10-21' },
            { attendanceRows: [], changeRows: [] },
        ), false);
        assert.equal(leaveCardMatchesOpenRequest(
            { requestId: 'hub-1', fromDate: '', title: 'Leave request' },
            { attendanceRows: [openLeave], changeRows: [openPunch] },
        ), false);
        assert.equal(leaveCardMatchesOpenRequest(
            { requestId: 'chg-1', fromDate: '2026-10-12', toDate: '2026-10-12' },
            { attendanceRows: [], changeRows: [openPunch] },
        ), true);
    });

    it('hides a salary row when that request was reassigned as a task', () => {
        const row = {
            id: 'leave-group-1',
            title: 'Miss Punch request',
            fromDate: '2026-10-12',
            toDate: '2026-10-12',
        };
        assert.equal(hiddenByReassignedLeave(row, [
            { reassigned: true, requestId: 'other', fromDate: '2026-10-16', toDate: '2026-10-16' },
        ]), false);
        assert.equal(hiddenByReassignedLeave(row, [
            { reassigned: true, requestId: 'task-1', fromDate: '2026-10-12', toDate: '2026-10-12' },
        ]), true);
        assert.equal(hiddenByReassignedLeave(
            { id: 'leave-task-abc', fromDate: '2026-08-15', toDate: '2026-08-15' },
            [{ reassigned: true, requestId: 'abc', fromDate: '2026-01-01', toDate: '2026-01-01' }],
        ), true);
    });
});
