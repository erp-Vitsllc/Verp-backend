import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    flowchartHrMayOverrideLeaveRules,
    leaveGroupIsApproved,
} from './flowchartHrLeaveOverride.js';

describe('flowchart HR approved leave edit', () => {
    it('lets flowchart HR change an approved leave without the override checkbox', () => {
        assert.equal(
            flowchartHrMayOverrideLeaveRules({
                designatedHr: true,
                revisingApprovedLeave: true,
            }),
            true,
        );
    });

    it('still requires the override flag for a new request', () => {
        assert.equal(
            flowchartHrMayOverrideLeaveRules({
                designatedHr: true,
                revisingApprovedLeave: false,
            }),
            false,
        );
        assert.equal(flowchartHrMayOverrideLeaveRules({ hrOverride: true }), true);
    });

    it('does not let another role skip the checks on an approved leave', () => {
        assert.equal(
            flowchartHrMayOverrideLeaveRules({
                designatedHr: false,
                revisingApprovedLeave: true,
            }),
            false,
        );
    });

    it('recognises an approved leave group', () => {
        assert.equal(leaveGroupIsApproved([{ leaveRequestStatus: 'pending' }]), false);
        assert.equal(
            leaveGroupIsApproved([
                { leaveRequestStatus: 'pending' },
                { leaveRequestStatus: 'approved' },
            ]),
            true,
        );
    });
});
