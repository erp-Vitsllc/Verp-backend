import test from "node:test";
import assert from "node:assert/strict";
import { generalHubClosures, stageBeforeHubClose } from "./alignDecidedGeneralHubTasks.js";

test("an approved salary certificate closes the still-pending task", () => {
    const certificate = {
        _id: "action-1",
        requestId: "hub-1",
        requestType: "Employee Certificate Request",
        status: "Pending",
    };
    const salary = {
        _id: "action-2",
        requestId: "hub-2",
        requestType: "Employee Salary Request",
        status: "On Hold",
    };
    const leave = {
        _id: "action-3",
        requestId: "hub-3",
        requestType: "Employee Leave Request",
        status: "Pending",
    };
    const plan = generalHubClosures(
        [certificate, salary, leave],
        new Map([
            ["hub-1", "Approved"],
            ["hub-2", "Rejected"],
            ["hub-3", "Approved"],
        ]),
    );
    assert.deepEqual(plan.approved.map((action) => action._id), ["action-1"]);
    assert.deepEqual(plan.rejected.map((action) => action._id), ["action-2"]);
    assert.equal(certificate.status, "Pending");
});

test("closing an early salary task remembers the assignee stage", () => {
    const stage = stageBeforeHubClose({
        status: "Pending",
        assignee: "emp-1",
        assigneeEmpId: "VEGA-HR-00001",
        assigneeName: "Raseel Muhammad",
        closeRequest: { reviewPending: false },
    });
    assert.equal(stage.status, "Pending");
    assert.equal(stage.assigneeId, "emp-1");
    assert.equal(stage.assigneeName, "Raseel Muhammad");
    assert.equal(stage.reviewPending, false);
});
