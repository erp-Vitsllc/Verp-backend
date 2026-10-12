import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    allowedApprovalEvents,
    approvalAllowanceBlock,
    approvalEventPool,
    attendanceApprovalLimitText,
} from './attendanceApprovalAllowance.js';

describe('attendance approval allowance', () => {
    it('shares late arrival and early go, and keeps missed punch separate', () => {
        assert.equal(approvalEventPool({ statusKey: 'late_arrived' }), 'late');
        assert.equal(approvalEventPool({ statusKey: 'early_go' }), 'late');
        assert.equal(approvalEventPool({ statusKey: 'mispunch' }), 'mispunch');
        assert.equal(
            approvalEventPool({
                statusKey: 'not_marked',
                leaveRequestStatus: 'pending',
                leaveRequestKind: 'future_early',
            }),
            'late',
        );
        assert.equal(
            approvalEventPool(
                { statusKey: 'on_office', timeIn: '09:00', timeOut: '' },
                { countOpenPunch: true },
            ),
            'mispunch',
        );
    });

    it('reads the salary policy event counts', () => {
        const policy = {
            lateInRules: [{ minutes: 15, events: 4, deduct: 'quarter' }],
            missedPunchRule: { events: 0, deduct: 'half' },
        };
        assert.equal(allowedApprovalEvents(policy, 'late'), 4);
        assert.equal(allowedApprovalEvents(policy, 'mispunch'), 0);
        assert.equal(allowedApprovalEvents({ lateInRules: [{ events: 4 }] }, 'late'), null);
    });

    it('blocks once the month is already over the allowed count', () => {
        const existing = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-06', '2026-10-07'];
        const block = approvalAllowanceBlock({
            allowed: 4,
            existingDates: existing,
            requestDates: ['2026-10-12'],
        });
        assert.equal(block.taken, 5);
        assert.equal(block.allowed, 4);
        assert.match(attendanceApprovalLimitText({ pool: 'late', taken: 5, allowed: 4 }), /already have 5/);
    });

    it('blocks a new request that would pass the allowed count', () => {
        const block = approvalAllowanceBlock({
            allowed: 4,
            existingDates: ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-06'],
            requestDates: ['2026-10-08'],
        });
        assert.equal(block.taken, 4);
    });

    it('allows a request that stays inside the count, including the day already counted', () => {
        assert.equal(
            approvalAllowanceBlock({
                allowed: 4,
                existingDates: ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-12'],
                requestDates: ['2026-10-12'],
            }),
            null,
        );
        assert.equal(
            approvalAllowanceBlock({
                allowed: 0,
                existingDates: ['2026-10-05'],
                requestDates: ['2026-10-05'],
            })?.taken,
            1,
        );
    });
});
