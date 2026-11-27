import assert from "node:assert/strict";
import test from "node:test";
import {
    openWorkOrderSteps,
    pendingTaskLabel,
    pendingTaskLine,
    projectCompletionBlockMessage,
    workOrderStepIsOpen,
} from "./workOrderProjectCompletion.js";

const root = { _id: "root", requestType: "Work Order Project", requestId: "wo" };

test("a pending work order task blocks the created project task", () => {
    const steps = openWorkOrderSteps(
        root,
        [
            { _id: "sales", requestType: "Work Order LPO", status: "Pending", extra1: "Add the supporting document" },
            { _id: "boq", requestType: "Work Order Actual BOQ", status: "Approved", extra1: "Actual BOQ" },
        ],
        [
            { sourceDashboardActionId: "sales", status: "Pending", taskName: "Sales kick off" },
            { sourceDashboardActionId: "boq", status: "Completed", taskName: "Actual BOQ" },
        ],
    );
    assert.deepEqual(steps.map((step) => step.label), ["Sales kick off"]);
    assert.match(projectCompletionBlockMessage(steps), /Sales kick off is still pending/);
});

test("a finished task does not block even when its action is still pending", () => {
    const steps = openWorkOrderSteps(
        root,
        [{ _id: "lpo", requestType: "Work Order LPO Approval", status: "Pending", extra1: "Approve the LPO" }],
        [{ sourceDashboardActionId: "lpo", status: "Completed", taskName: "LPO to vendor" }],
    );
    assert.equal(steps.length, 0);
    assert.equal(projectCompletionBlockMessage(steps), "");
});

test("a checklist row with no task yet stays pending", () => {
    assert.equal(workOrderStepIsOpen({ status: "Pending" }, []), true);
    assert.equal(workOrderStepIsOpen({ status: "Approved" }, []), false);
    const steps = openWorkOrderSteps(
        root,
        [{ _id: "mom", requestType: "Work Order Checklist", status: "Pending", extra1: "MOM" }],
        [],
    );
    assert.equal(steps[0].label, "MOM");
});

test("another request type is not gated by work order tasks", () => {
    const steps = openWorkOrderSteps(
        { _id: "other", requestType: "Fine", requestId: "wo" },
        [{ _id: "sales", requestType: "Work Order LPO", status: "Pending" }],
        [],
    );
    assert.equal(steps.length, 0);
});

test("a pending line names the task and the employee", () => {
    assert.equal(
        pendingTaskLine(pendingTaskLabel("Approve the LPO on WO-26-004", "WO-26-004"), "Sara Ali"),
        "pending Approve the LPO on Sara Ali",
    );
    assert.equal(
        pendingTaskLabel("Upload attachment to the work order WO-26-004", "WO-26-004"),
        "Upload attachment",
    );
    assert.equal(pendingTaskLabel("Create work order WO-26-004", "WO-26-004"), "Create work order");
    assert.equal(pendingTaskLabel("Create the MR for WO-26-004", "WO-26-004"), "Create the MR");
    assert.equal(pendingTaskLine("Sales kick off", ""), "pending Sales kick off");
});

test("several pending tasks are named together", () => {
    const message = projectCompletionBlockMessage([
        { label: "MOM" },
        { label: "Budget" },
        { label: "Delivery" },
        { label: "Bill entry" },
    ]);
    assert.match(message, /MOM, Budget, Delivery and 1 more/);
});
