import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectPendingCalendarRequests } from './groupCalendarRequests.js';

const window = { from: '2026-10-01', to: '2026-10-31' };
const names = new Map([['emp-1', 'Abbas Raza']]);
const approversByEmployee = new Map([['emp-1', {
    reporteeId: 'mgr-1',
    reporteeName: 'Sara Manager',
    hrId: 'hr-1',
    hrName: 'Nesmi HR',
}]]);

describe('collectPendingCalendarRequests', () => {
    it('keeps a pending leave, late, early, and missed punch, and names who requested it', () => {
        const pending = collectPendingCalendarRequests({
            ...window,
            employeeNames: names,
            approversByEmployee,
            attendanceRows: [
                {
                    employeeMongoId: 'emp-1',
                    date: '2026-10-02',
                    leaveRequestStatus: 'pending',
                    leaveRequestKind: 'future_leave',
                    requestedStatusKey: 'authorized_leave',
                    requestedStatusLabel: 'Authorized Leave',
                },
                {
                    employeeMongoId: 'emp-1',
                    date: '2026-10-05',
                    leaveRequestStatus: 'pending',
                    leaveRequestKind: 'past_late',
                    requestedStatusKey: 'late_arrived',
                },
                {
                    employeeMongoId: 'emp-1',
                    date: '2026-10-06',
                    leaveRequestStatus: 'pending',
                    leaveRequestKind: 'future_early',
                    requestedStatusKey: 'early_go',
                },
                {
                    employeeMongoId: 'emp-1',
                    date: '2026-10-07',
                    leaveRequestStatus: 'pending',
                    leaveRequestKind: 'yellow',
                    requestedStatusKey: 'mispunch',
                },
            ],
        });
        const rows = pending.get('emp-1');
        assert.deepEqual(rows.map((row) => row.label), [
            'Authorized Leave request',
            'Late in request',
            'Early out request',
            'Missed punch request',
        ]);
        assert.equal(rows[0].requestedBy, 'Abbas Raza');
        assert.deepEqual(rows.map((row) => row.pendingWith), [
            'Nesmi HR',
            'Sara Manager',
            'Sara Manager',
            'Sara Manager',
        ]);
    });

    it('leaves out a completed request and a next-day overtime date', () => {
        const pending = collectPendingCalendarRequests({
            ...window,
            employeeNames: names,
            attendanceRows: [
                {
                    employeeMongoId: 'emp-1',
                    date: '2026-10-08',
                    leaveRequestStatus: 'approved',
                    requestedStatusKey: 'on_leave',
                },
                {
                    employeeMongoId: 'emp-1',
                    date: '2026-10-09',
                    statusKey: 'late_arrived',
                    leaveRequestStatus: '',
                },
            ],
            changeRows: [
                {
                    employeeMongoId: 'emp-1',
                    date: '2026-10-03',
                    stage: 'approved',
                    action: 'flexible_ot',
                    requestedByName: 'Sara HR',
                    proposed: { confirmNextDay: true, targetDate: '2026-10-04' },
                },
                {
                    employeeMongoId: 'emp-1',
                    date: '2026-10-12',
                    stage: 'pending_hr',
                    action: 'hour_adjust',
                    requestedByName: 'Nesmi Shamsudeen',
                    hrName: 'Sara HR',
                },
            ],
        });
        const rows = pending.get('emp-1') || [];
        assert.deepEqual(rows, [
            {
                date: '2026-10-12',
                label: 'Hour approval request',
                requestedBy: 'Nesmi Shamsudeen',
                pendingWith: 'Sara HR',
            },
        ]);
    });

    it('names whoever the hour request is waiting on now', () => {
        const pending = collectPendingCalendarRequests({
            ...window,
            employeeNames: names,
            changeRows: [
                {
                    employeeMongoId: 'emp-1',
                    date: '2026-10-10',
                    stage: 'pending_reportee',
                    action: 'hour_adjust',
                    requestedByName: 'Ram Bahadur Bhujel',
                    reporteeName: 'Sara Manager',
                    hrName: 'Nesmi HR',
                },
                {
                    employeeMongoId: 'emp-1',
                    date: '2026-10-11',
                    stage: 'pending_requester',
                    action: 'hour_adjust',
                    requestedByName: 'Ram Bahadur Bhujel',
                    reporteeName: 'Sara Manager',
                    hrName: 'Nesmi HR',
                },
            ],
        });
        const rows = pending.get('emp-1') || [];
        assert.deepEqual(rows.map((row) => row.pendingWith), [
            'Sara Manager',
            'Ram Bahadur Bhujel',
        ]);
    });
});
