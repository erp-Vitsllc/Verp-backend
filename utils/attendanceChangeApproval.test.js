import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    approvalStageForAttendanceChange,
    attendanceMarksMatch,
    describeAttendanceSave,
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
