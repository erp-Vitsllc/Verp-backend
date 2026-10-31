import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyLeaveTaskReopen, planLeaveTaskReopen } from './reopenLeaveRequestTask.js';

const LEAVE = 'Employee Leave Request';

describe('planLeaveTaskReopen', () => {
    it('reopens the completed leave task and drops a newer pending copy', () => {
        const completed = {
            _id: 'task-1',
            requestType: LEAVE,
            status: 'Approved',
            updatedAt: '2026-08-01T00:00:00.000Z',
        };
        const copy = {
            _id: 'task-2',
            requestType: LEAVE,
            status: 'Pending',
            updatedAt: '2026-08-02T00:00:00.000Z',
        };
        const plan = planLeaveTaskReopen(
            [copy, completed],
            [{ _id: 'overlay-1', sourceDashboardActionId: 'task-1', status: 'Completed', updatedAt: '2026-08-01T00:00:00.000Z' }],
        );

        assert.equal(plan.action._id, 'task-1');
        assert.equal(plan.overlay._id, 'overlay-1');
        assert.deepEqual(plan.dismissIds, ['task-2']);
    });

    it('keeps the only completed leave task when nothing else is open', () => {
        const completed = {
            _id: 'task-1',
            requestType: LEAVE,
            status: 'Approved',
            updatedAt: '2026-08-01T00:00:00.000Z',
        };
        const plan = planLeaveTaskReopen([completed], []);

        assert.equal(plan.action._id, 'task-1');
        assert.equal(plan.overlay, null);
        assert.deepEqual(plan.dismissIds, []);
    });

    it('does not choose a dismissed copy over the approved task', () => {
        const plan = planLeaveTaskReopen([
            { _id: 'gone', requestType: LEAVE, status: 'Dismissed', updatedAt: '2026-08-03T00:00:00.000Z' },
            { _id: 'kept', requestType: LEAVE, status: 'Approved', updatedAt: '2026-08-01T00:00:00.000Z' },
        ], []);

        assert.equal(plan.action._id, 'kept');
    });
});

describe('applyLeaveTaskReopen', () => {
    it('opens a completed task again without treating it as a new task', () => {
        const task = {
            status: 'Completed',
            assignee: 'old',
            closeRequest: { closedAt: '2026-08-01T00:00:00.000Z', closedByName: 'HR' },
            history: [],
        };
        const changed = applyLeaveTaskReopen(
            task,
            { _id: 'mgr', employeeId: 'E1', firstName: 'Sara', lastName: 'Khan' },
        );

        assert.equal(changed, true);
        assert.equal(task.status, 'Pending');
        assert.equal(task.assignee, 'mgr');
        assert.equal(task.assigneeName, 'Sara Khan');
        assert.equal(task.closeRequest.closedAt, null);
        assert.ok(task.closeRequest.reopenedAt);
        assert.equal(task.history[0].event, 'Reopened');
    });

    it('leaves an already open task in place', () => {
        const task = { status: 'Pending', assignee: 'mgr', history: [] };
        const changed = applyLeaveTaskReopen(task, null);

        assert.equal(changed, false);
        assert.equal(task.status, 'Pending');
        assert.equal(task.history.length, 0);
    });
});
