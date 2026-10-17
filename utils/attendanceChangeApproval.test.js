import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    approvalRequestType,
    approvalStageForAttendanceChange,
    attendanceChangeSummary,
    attendanceMarksMatch,
    describeAttendanceSave,
    hourRejectNextStage,
    hourResubmitStage,
} from './attendanceChangeApproval.js';

describe('approvalStageForAttendanceChange', () => {
    it('lets flowchart HR save immediately', () => {
        assert.equal(
            approvalStageForAttendanceChange({
                actorIsHr: true,
                actorId: 'hr',
                reporteeId: 'mgr',
                hrId: 'hr',
            }),
            'apply',
        );
    });

    it('sends a primary reportee edit straight to HR', () => {
        assert.equal(
            approvalStageForAttendanceChange({
                actorIsHr: false,
                actorId: 'mgr',
                reporteeId: 'mgr',
                hrId: 'hr',
            }),
            'pending_hr',
        );
    });

    it('asks the primary reportee first when someone else edits', () => {
        assert.equal(
            approvalStageForAttendanceChange({
                actorIsHr: false,
                actorId: 'other',
                reporteeId: 'mgr',
                hrId: 'hr',
            }),
            'pending_reportee',
        );
    });

    it('uses one HR approval when the reportee is HR', () => {
        assert.equal(
            approvalStageForAttendanceChange({
                actorIsHr: false,
                actorId: 'other',
                reporteeId: 'hr',
                hrId: 'hr',
            }),
            'pending_hr',
        );
    });

    it('sends the change to HR when the employee has no primary reportee', () => {
        assert.equal(
            approvalStageForAttendanceChange({
                actorIsHr: false,
                actorId: 'other',
                reporteeId: '',
                hrId: 'hr',
            }),
            'pending_hr',
        );
    });
});

describe('hourRejectNextStage', () => {
    it('sends an HR rejection back to the HOD', () => {
        assert.equal(
            hourRejectNextStage({
                stage: 'pending_hr',
                reporteeId: 'hod',
                hrId: 'hr',
                requesterId: 'req',
            }),
            'pending_reportee',
        );
    });

    it('sends an HOD rejection back to the requester', () => {
        assert.equal(
            hourRejectNextStage({
                stage: 'pending_reportee',
                reporteeId: 'hod',
                hrId: 'hr',
                requesterId: 'req',
            }),
            'pending_requester',
        );
    });

    it('removes the request when the requester rejects it', () => {
        assert.equal(
            hourRejectNextStage({
                stage: 'pending_requester',
                reporteeId: 'hod',
                hrId: 'hr',
                requesterId: 'req',
            }),
            'gone',
        );
    });

    it('sends an HR rejection to the requester when the HOD sent it', () => {
        assert.equal(
            hourRejectNextStage({
                stage: 'pending_hr',
                reporteeId: 'req',
                hrId: 'hr',
                requesterId: 'req',
            }),
            'pending_requester',
        );
    });

    it('sends an HR rejection to the requester when there is no HOD', () => {
        assert.equal(
            hourRejectNextStage({
                stage: 'pending_hr',
                reporteeId: '',
                hrId: 'hr',
                requesterId: 'req',
            }),
            'pending_requester',
        );
    });
});

describe('hourResubmitStage', () => {
    it('sends the requester back to the HOD', () => {
        assert.equal(
            hourResubmitStage({
                reporteeId: 'hod',
                hrId: 'hr',
                requesterId: 'req',
            }),
            'pending_reportee',
        );
    });

    it('sends the requester to HR when they are the HOD', () => {
        assert.equal(
            hourResubmitStage({
                reporteeId: 'req',
                hrId: 'hr',
                requesterId: 'req',
            }),
            'pending_hr',
        );
    });
});

describe('attendanceMarksMatch', () => {
    it('treats the same status and times as no change', () => {
        assert.equal(
            attendanceMarksMatch(
                {
                    statusKey: 'on_office',
                    statusLabel: 'Present',
                    timeIn: '09:00',
                    timeOut: '18:00',
                    reason: '',
                    attachmentName: '',
                },
                {
                    statusKey: 'on_office',
                    statusLabel: 'Present',
                    timeIn: '09:00',
                    timeOut: '18:00',
                    reason: '',
                    attachmentName: '',
                },
            ),
            true,
        );
    });
});

describe('attendanceChangeSummary', () => {
    it('keeps a next-day present request on the chosen date', () => {
        const summary = attendanceChangeSummary({
            action: 'flexible_ot',
            stage: 'pending_hr',
            proposed: {
                statusLabel: 'Next day present on 2026-10-14',
                confirmNextDay: true,
                targetDate: '2026-10-14',
            },
        });
        assert.match(summary, /Next day present on 2026-10-14/);
        assert.match(summary, /Waiting for HR/);
        assert.doesNotMatch(summary, /approved ot/i);
    });
});

describe('approvalRequestType', () => {
    it('names hour approvals by the request that was approved', () => {
        assert.equal(approvalRequestType({ action: 'hour_adjust', proposed: { hourAdjustKind: 'early_go' } }), 'Early out');
        assert.equal(
            approvalRequestType({ action: 'hour_adjust', proposed: { hourAdjustKind: 'late_arrived' } }),
            'Late arrival',
        );
        assert.equal(
            approvalRequestType({ action: 'hour_adjust', proposed: { hourAdjustKind: 'authorized_leave' } }),
            'Unauth to Auth',
        );
        assert.equal(approvalRequestType({ action: 'hour_adjust', proposed: { hourAdjustKind: 'mispunch' } }), 'Mispunch');
    });

    it('names a status change from the previous day to the approved day', () => {
        assert.equal(
            approvalRequestType({
                action: 'mark',
                previous: { statusKey: 'unauthorized_leave', statusLabel: 'Unauthorized Leave' },
                proposed: { statusKey: 'authorized_leave', statusLabel: 'Authorized Leave' },
            }),
            'Unauth to Auth',
        );
        assert.equal(
            approvalRequestType({
                action: 'mark',
                previous: { statusKey: 'on_office', statusLabel: 'Present' },
                proposed: { statusKey: 'early_go', statusLabel: 'Early Go' },
            }),
            'Present to Early out',
        );
    });

    it('names overtime on the worked day and present on the next day', () => {
        const request = {
            action: 'flexible_ot',
            date: '2026-10-15',
            proposed: { confirmNextDay: true, targetDate: '2026-10-16' },
        };
        assert.equal(approvalRequestType({ ...request, viewDate: '2026-10-15' }), 'OT approval');
        assert.equal(approvalRequestType({ ...request, viewDate: '2026-10-16' }), 'Present from OT');
    });

    it('names an approved leave request from its kind', () => {
        assert.equal(approvalRequestType({ action: 'leave', leaveRequestKind: 'future_early' }), 'Early out');
        assert.equal(approvalRequestType({ action: 'leave', leaveRequestKind: 'past_late' }), 'Late arrival');
        assert.equal(
            approvalRequestType({
                action: 'leave',
                leaveRequestKind: 'leave',
                previousStatusKey: 'unauthorized_leave',
                previousStatusLabel: 'Unauthorized Leave',
                requestedStatusKey: 'authorized_leave',
                requestedStatusLabel: 'Authorized Leave',
            }),
            'Unauth to Auth',
        );
    });
});

describe('describeAttendanceSave', () => {
    it('tells the marker that HR still has to approve', () => {
        const message = describeAttendanceSave({
            savedCount: 0,
            pending: [{ stage: 'pending_reportee' }],
        });
        assert.match(message, /primary reportee/);
        assert.match(message, /HR approves/);
    });
});
