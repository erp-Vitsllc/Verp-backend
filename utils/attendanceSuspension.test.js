import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isAttendanceSuspendedOn,
    overlaySuspendedAttendance,
    suspendedAttendanceView,
} from './attendanceSuspension.js';

const employee = {
    _id: 'abc',
    employeeId: 'VEGA-HR-0001',
    firstName: 'Abbas',
    lastName: 'Raza',
    attendanceAccountStatus: 'suspended',
    attendanceSuspension: {
        fromDate: '2026-10-17',
        untilDate: '2026-10-19',
        description: 'Hold',
    },
};

test('default active employees are not suspended', () => {
    assert.equal(isAttendanceSuspendedOn({ attendanceAccountStatus: 'active' }, '2026-10-17'), false);
    assert.equal(isAttendanceSuspendedOn({}, '2026-10-17'), false);
});

test('suspension is inclusive and does not apply outside the window', () => {
    assert.equal(isAttendanceSuspendedOn(employee, '2026-10-16'), false);
    assert.equal(isAttendanceSuspendedOn(employee, '2026-10-17'), true);
    assert.equal(isAttendanceSuspendedOn(employee, '2026-10-19'), true);
    assert.equal(isAttendanceSuspendedOn(employee, '2026-10-20'), false);
});

test('overlay replaces the visible day and leaves the stored row untouched', () => {
    const stored = {
        _id: 'row1',
        date: '2026-10-17',
        statusKey: 'on_office',
        statusLabel: 'Present',
        timeIn: '09:00',
        timeOut: '18:00',
    };
    const shown = overlaySuspendedAttendance([stored], employee, '2026-10-01', '2026-10-31');
    const day = shown.find((row) => row.date === '2026-10-17');
    assert.equal(day.statusKey, 'suspended');
    assert.equal(day.statusLabel, 'Suspended');
    assert.equal(day._id, undefined);
    assert.equal(stored.statusKey, 'on_office');
    assert.equal(stored.timeIn, '09:00');
    assert.equal(shown.some((row) => row.date === '2026-10-18' && row.statusKey === 'suspended'), true);
    assert.equal(suspendedAttendanceView(employee, '2026-10-17').reason, 'Hold');
});
