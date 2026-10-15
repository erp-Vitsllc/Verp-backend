import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectPendingCalendarRequests } from './groupCalendarRequests.js';

const window = { from: '2026-10-01', to: '2026-10-31' };
const names = new Map([['emp-1', 'Abbas Raza']]);

describe('collectPendingCalendarRequests', () => {
    it('keeps a pending leave, late, early, and missed punch, and names who requested it', () => {
        const pending = collectPendingCalendarRequests({
            ...window,
            employeeNames: names,
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
                },
            ],
        });
        const rows = pending.get('emp-1') || [];
        assert.deepEqual(rows, [
            {
                date: '2026-10-12',
                label: 'Hour approval request',
                requestedBy: 'Nesmi Shamsudeen',
            },
        ]);
    });
});
