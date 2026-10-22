import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    inferLeaveApprovalStage,
    isTwoStepLeaveKind,
    leaveApproverCanDecide,
    openingLeaveApprovalStage,
} from './leaveRequestApproval.js';

describe('openingLeaveApprovalStage', () => {
    it('starts with the primary reportee', () => {
        assert.equal(openingLeaveApprovalStage('mgr', 'hr'), 'pending_reportee');
    });

    it('starts with the primary reportee even when that person is also HR', () => {
        assert.equal(openingLeaveApprovalStage('hr', 'hr'), 'pending_reportee');
    });

    it('starts with HR when there is no reportee', () => {
        assert.equal(openingLeaveApprovalStage('', 'hr'), 'pending_hr');
    });
});

describe('inferLeaveApprovalStage', () => {
    it('keeps a stored stage', () => {
        assert.equal(
            inferLeaveApprovalStage(
                { leaveApprovalStage: 'pending_hr', leaveRequestKind: 'leave' },
                { reporteeId: 'mgr', hrId: 'hr' },
            ),
            'pending_hr',
        );
    });

    it('treats older future leave as waiting on the primary reportee', () => {
        assert.equal(
            inferLeaveApprovalStage(
                { leaveRequestKind: 'future_annual' },
                { reporteeId: 'mgr', hrId: 'hr' },
            ),
            'pending_reportee',
        );
    });

    it('treats older sick and miss-punch requests as with the reportee', () => {
        assert.equal(
            inferLeaveApprovalStage({ leaveRequestKind: 'yellow' }, { reporteeId: 'mgr', hrId: 'hr' }),
            'pending_reportee',
        );
    });
});

describe('leaveApproverCanDecide', () => {
    it('lets only the primary reportee decide the first step', () => {
        assert.equal(
            leaveApproverCanDecide({
                stage: 'pending_reportee',
                actorId: 'mgr',
                reporteeId: 'mgr',
                hrId: 'hr',
            }),
            true,
        );
        assert.equal(
            leaveApproverCanDecide({
                stage: 'pending_reportee',
                actorId: 'hr',
                reporteeId: 'mgr',
                hrId: 'hr',
            }),
            false,
        );
    });

    it('lets only HR decide the second step', () => {
        assert.equal(
            leaveApproverCanDecide({
                stage: 'pending_hr',
                actorId: 'hr',
                reporteeId: 'mgr',
                hrId: 'hr',
            }),
            true,
        );
        assert.equal(
            leaveApproverCanDecide({
                stage: 'pending_hr',
                actorId: 'mgr',
                reporteeId: 'mgr',
                hrId: 'hr',
            }),
            false,
        );
    });
});

describe('isTwoStepLeaveKind', () => {
    it('includes leave, miss punch, late in, and early out', () => {
        assert.equal(isTwoStepLeaveKind('leave'), true);
        assert.equal(isTwoStepLeaveKind('yellow'), true);
        assert.equal(isTwoStepLeaveKind('future_late'), true);
        assert.equal(isTwoStepLeaveKind('future_early'), true);
        assert.equal(isTwoStepLeaveKind('past_late'), true);
        assert.equal(isTwoStepLeaveKind('attendance_change'), false);
    });
});
