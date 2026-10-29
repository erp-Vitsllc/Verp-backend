import test from "node:test";
import assert from "node:assert/strict";
import { isSystemOrWorkflowTask, superUserRejectsImmediately } from "./taskRejectAccess.js";

const admin = { superUser: true, name: "Admin" };
const assignee = { superUser: false, name: "Assignee" };

test("system and workflow tasks are the final-reject types", () => {
    assert.equal(isSystemOrWorkflowTask({ taskType: "System Task" }), true);
    assert.equal(isSystemOrWorkflowTask({ taskType: "Workflow Task" }), true);
    assert.equal(isSystemOrWorkflowTask({ taskType: "Work Flow Task" }), true);
    assert.equal(isSystemOrWorkflowTask({ taskType: "General Task" }, "Workflow Task"), false);
    assert.equal(isSystemOrWorkflowTask(null, "System Task"), true);
    assert.equal(isSystemOrWorkflowTask(null, "General Task"), false);
});

test("only an admin super user rejects a system or workflow task immediately", () => {
    assert.equal(superUserRejectsImmediately({ taskType: "System Task" }, admin), true);
    assert.equal(superUserRejectsImmediately({ taskType: "Workflow Task" }, admin), true);
    assert.equal(superUserRejectsImmediately({ taskType: "Work Flow Task" }, admin), true);
    assert.equal(superUserRejectsImmediately({ taskType: "General Task" }, admin, "Workflow Task"), false);
    assert.equal(superUserRejectsImmediately({ taskType: "System Task" }, assignee), false);
    assert.equal(superUserRejectsImmediately(null, admin, "Workflow Task"), true);
});
