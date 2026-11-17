import test from "node:test";
import assert from "node:assert/strict";
import { taskEditAndReassignAccess } from "./taskManagerModule.js";

test("assignee and reassignee cannot edit an open task", () => {
    const assignee = taskEditAndReassignAccess({ open: true, assignee: true });
    assert.equal(assignee.canEdit, false);
    assert.equal(assignee.canReassign, true);

    const reassignee = taskEditAndReassignAccess({ open: true, assignee: true, originalAssignee: false });
    assert.equal(reassignee.canEdit, false);
    assert.equal(reassignee.canReassign, true);
});

test("requester and admin super user can edit", () => {
    assert.equal(taskEditAndReassignAccess({ open: true, requester: true }).canEdit, true);
    assert.equal(taskEditAndReassignAccess({ open: true, superUser: true }).canEdit, true);
    assert.equal(taskEditAndReassignAccess({ open: true, originalAssignee: true }).canEdit, false);
});

test("before completion, the assignee and the requester can both reassign", () => {
    assert.equal(taskEditAndReassignAccess({ open: true, assignee: true }).canReassign, true);
    assert.equal(taskEditAndReassignAccess({ open: true, requester: true }).canReassign, true);
    assert.equal(taskEditAndReassignAccess({ open: true, requester: true }).canAssign, false);
});

test("after the assignee completes, reassign stays with the requester and admin", () => {
    const waiting = { open: true, reviewPending: true, completionPending: true };
    assert.deepEqual(
        taskEditAndReassignAccess({ ...waiting, assignee: true }),
        { canEdit: false, canReassign: false, canAssign: false },
    );
    assert.deepEqual(
        taskEditAndReassignAccess({ ...waiting, originalAssignee: true }),
        { canEdit: false, canReassign: false, canAssign: false },
    );
    assert.deepEqual(
        taskEditAndReassignAccess({ ...waiting, requester: true }),
        { canEdit: true, canReassign: true, canAssign: false },
    );
    assert.deepEqual(
        taskEditAndReassignAccess({ ...waiting, superUser: true }),
        { canEdit: true, canReassign: true, canAssign: false },
    );
});

test("after the requester approves, reassign is replaced by assign", () => {
    const approved = { open: true, reviewAccepted: true };
    assert.deepEqual(
        taskEditAndReassignAccess({ ...approved, requester: true }),
        { canEdit: true, canReassign: false, canAssign: true },
    );
    assert.deepEqual(
        taskEditAndReassignAccess({ ...approved, superUser: true }),
        { canEdit: true, canReassign: false, canAssign: true },
    );
    assert.deepEqual(
        taskEditAndReassignAccess({ ...approved, assignee: true }),
        { canEdit: false, canReassign: false, canAssign: false },
    );
});

test("a reassigned employee who submitted completion cannot reassign", () => {
    const waiting = { open: true, completionPending: true };
    assert.equal(taskEditAndReassignAccess({ ...waiting, assignee: true }).canReassign, false);
    assert.equal(taskEditAndReassignAccess({ ...waiting, assignee: true }).canEdit, false);
    assert.equal(taskEditAndReassignAccess({ ...waiting, originalAssignee: true }).canReassign, true);
    assert.equal(taskEditAndReassignAccess({ ...waiting, originalAssignee: true }).canEdit, false);
    assert.equal(taskEditAndReassignAccess({ ...waiting, requester: true }).canReassign, true);
});

test("a closed task hides edit and reassign", () => {
    const closed = taskEditAndReassignAccess({
        open: false,
        requester: true,
        superUser: true,
        assignee: true,
        reviewPending: true,
    });
    assert.equal(closed.canEdit, false);
    assert.equal(closed.canReassign, false);
    assert.equal(closed.canAssign, false);
});
