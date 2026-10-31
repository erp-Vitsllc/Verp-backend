import test from "node:test";
import assert from "node:assert/strict";
import {
    categoryForAutoComplete,
    shouldAutoCompleteSystemWorkflowTask,
} from "./completeFinishedSystemWorkflowTasks.js";

const finished = {
    category: "Workflow Task",
    status: "Pending",
    actionStatus: "Pending",
    sourceApplies: true,
    sourcePending: false,
    sourceFinished: true,
    workNoticePending: true,
    hadNotice: true,
};

test("a finished service or workflow record completes its task and clears a remaining notification", () => {
    assert.equal(shouldAutoCompleteSystemWorkflowTask(finished), true);
    assert.equal(shouldAutoCompleteSystemWorkflowTask({
        ...finished,
        category: "System Task",
        workNoticePending: false,
        actionStatus: "Approved",
    }), true);
    assert.equal(shouldAutoCompleteSystemWorkflowTask({
        ...finished,
        sourceFinished: false,
        sourcePending: true,
        workNoticePending: false,
        actionStatus: "Approved",
    }), false);
});

test("a notification nobody still sees completes a system or workflow task", () => {
    assert.equal(shouldAutoCompleteSystemWorkflowTask({
        category: "Workflow Task",
        status: "In Progress",
        actionStatus: "Approved",
        hadNotice: true,
        workNoticePending: false,
        ownBellPending: false,
    }), true);
    assert.equal(shouldAutoCompleteSystemWorkflowTask({
        category: "System Task",
        status: "Pending",
        actionStatus: "Pending",
        hadNotice: true,
        workNoticePending: true,
    }), false);
    assert.equal(shouldAutoCompleteSystemWorkflowTask({
        category: "Workflow Task",
        status: "Pending",
        ownBellPending: true,
        hadNotice: true,
    }), false);
    assert.equal(shouldAutoCompleteSystemWorkflowTask({
        category: "Workflow Task",
        status: "Pending",
        hadNotice: false,
    }), false);
});

test("deleted, rejected, cancelled, reopened, and general tasks stay unchanged", () => {
    assert.equal(shouldAutoCompleteSystemWorkflowTask({ ...finished, deleted: true }), false);
    assert.equal(shouldAutoCompleteSystemWorkflowTask({ ...finished, reopened: true }), false);
    assert.equal(shouldAutoCompleteSystemWorkflowTask({ ...finished, status: "Rejected" }), false);
    assert.equal(shouldAutoCompleteSystemWorkflowTask({ ...finished, status: "Cancelled" }), false);
    assert.equal(shouldAutoCompleteSystemWorkflowTask({ ...finished, status: "Completed" }), false);
    assert.equal(shouldAutoCompleteSystemWorkflowTask({ ...finished, actionStatus: "Rejected" }), false);
    assert.equal(shouldAutoCompleteSystemWorkflowTask({ ...finished, category: "General Task" }), false);
});

test("only a system or workflow task is eligible", () => {
    assert.equal(categoryForAutoComplete(
        { taskType: "Work Flow Task" },
        null,
    ), "Workflow Task");
    assert.equal(categoryForAutoComplete(
        { taskType: "General Task" },
        null,
    ), "General Task");
    assert.equal(categoryForAutoComplete(
        null,
        { requestType: "Vehicle Service Request" },
    ), "Workflow Task");
    assert.equal(categoryForAutoComplete(
        null,
        { requestType: "Employee Document Expiry Reminder" },
    ), "System Task");
    assert.equal(categoryForAutoComplete(
        { taskType: "Workflow Task" },
        { requestType: "Employee Certificate Request" },
    ), "General Task");
    assert.equal(categoryForAutoComplete(
        { taskType: "System Task" },
        { requestType: "Salary Enrollment", extra2: "pending for enrollment" },
    ), "System Task");
});
