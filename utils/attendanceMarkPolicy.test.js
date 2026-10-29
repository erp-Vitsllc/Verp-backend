import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attendanceMarkRoute } from './attendanceMarkPolicy.js';

describe('attendanceMarkRoute', () => {
    it('saves present, comp-off leave, and zero-hour yellow marks immediately', () => {
        assert.equal(attendanceMarkRoute({ statusKey: 'on_office' }), 'direct');
        assert.equal(attendanceMarkRoute({ statusKey: 'compoff_leave' }), 'direct');
        assert.equal(attendanceMarkRoute({ statusKey: 'early_go', clockHours: 0, deductionHours: 0 }), 'direct');
        assert.equal(attendanceMarkRoute({ statusKey: 'late_arrived' }), 'direct');
        assert.equal(attendanceMarkRoute({ statusKey: 'mispunch' }), 'direct');
    });

    it('sends non-zero yellow hours and deductions for approval', () => {
        assert.equal(attendanceMarkRoute({ statusKey: 'early_go', clockHours: 0.5 }), 'approve');
        assert.equal(attendanceMarkRoute({ statusKey: 'late_arrived', deductionHours: 0.25 }), 'approve');
        assert.equal(attendanceMarkRoute({ statusKey: 'mispunch', approvedHours: 1 }), 'approve');
        assert.equal(attendanceMarkRoute({ statusKey: 'mispunch', deductionHours: 1 }), 'approve');
    });

    it('sends leave for approval', () => {
        for (const statusKey of ['sick_leave', 'authorized_leave', 'on_leave', 'unauthorized_leave']) {
            assert.equal(attendanceMarkRoute({ statusKey }), 'approve');
        }
    });
});
