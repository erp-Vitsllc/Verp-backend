import assert from "node:assert/strict";
import test from "node:test";
import { flowchartHrOwnsTask, planNoticeSync } from "./syncNotificationTasks.js";

const hr = { _id: "hr-1", employeeId: "VEGA-HR-0001" };
const viewer = { employeeObjectId: "hr-1", employeeId: "VEGA-HR-0001" };

test("each live notification keeps one task, and a finished one is completed", () => {
    const openRows = [
        { _id: "row-a", requestId: "emp-a", assignedTo: "hr-1", extra1: "old", subjectName: "A", subjectEmployeeId: "E-A" },
        { _id: "row-b", requestId: "emp-b", assignedTo: "old-hr", extra1: "still open", subjectName: "B", subjectEmployeeId: "E-B" },
        { _id: "row-copy", requestId: "emp-b", assignedTo: "old-hr", extra1: "still open", subjectName: "B", subjectEmployeeId: "E-B" },
        { _id: "row-done", requestId: "emp-done", assignedTo: "hr-1", extra1: "done", subjectName: "Done", subjectEmployeeId: "E-D" },
    ];
    const liveItems = [
        { requestId: "emp-a", extra1: "Profile incomplete for A", extra2: "A (E-A)", subjectName: "A", subjectEmployeeId: "E-A" },
        { requestId: "emp-b", extra1: "still open", extra2: "B (E-B)", subjectName: "B", subjectEmployeeId: "E-B" },
        { requestId: "emp-new", extra1: "Profile incomplete for C", extra2: "C (E-C)", subjectName: "C", subjectEmployeeId: "E-C" },
    ];

    const plan = planNoticeSync({ openRows, liveItems, assigneeId: "hr-1", deletedKeys: new Set() });

    assert.deepEqual(plan.completeIds, ["row-done"]);
    assert.deepEqual(plan.dismissIds, ["row-copy"]);
    assert.equal(plan.updates.length, 2);
    assert.equal(plan.updates.find((row) => String(row.id) === "row-a").assigneeChanged, false);
    assert.equal(plan.updates.find((row) => String(row.id) === "row-b").assigneeChanged, true);
    assert.deepEqual(plan.creates.map((item) => item.requestId), ["emp-new"]);
});

test("a deleted notification is not opened again", () => {
    const item = {
        requestId: "emp-a",
        requestType: "Profile Incomplete",
        extra1: "Profile incomplete for A",
        subjectEmployeeId: "E-A",
    };
    const plan = planNoticeSync({
        openRows: [{ _id: "row-a", requestId: "emp-a", assignedTo: "hr-1", extra1: item.extra1 }],
        liveItems: [item],
        assigneeId: "hr-1",
        deletedKeys: new Set(["TASK|Profile Incomplete|emp-a"]),
    });
    assert.deepEqual(plan.dismissIds, ["row-a"]);
    assert.deepEqual(plan.creates, []);
    assert.deepEqual(plan.updates, []);
});

test("the flowchart HR sees the same activation queue on My Task that the bell already shows", () => {
    assert.equal(flowchartHrOwnsTask(viewer, { status: "Pending", requestType: "Profile Activation" }, hr), true);
    assert.equal(flowchartHrOwnsTask(viewer, { status: "Pending", requestType: "Company Activation" }, hr), true);
    assert.equal(flowchartHrOwnsTask(viewer, { status: "Pending", requestType: "Profile Incomplete" }, hr), true);
    assert.equal(flowchartHrOwnsTask(viewer, { status: "On Hold", requestType: "Profile Activation" }, hr), false);
    assert.equal(flowchartHrOwnsTask(
        { employeeObjectId: "someone-else", employeeId: "E-9" },
        { status: "Pending", requestType: "Profile Activation" },
        hr,
    ), false);
});
