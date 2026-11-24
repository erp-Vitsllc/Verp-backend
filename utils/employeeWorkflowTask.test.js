import assert from "node:assert/strict";
import test from "node:test";
import {
    assigneeHistoryEntry,
    createdHistoryEntry,
    employeeWorkflowType,
} from "./employeeWorkflowTask.js";

test("draft bill, fine, loan, and advance rows are employee workflow tasks", () => {
    assert.equal(employeeWorkflowType("Inventory Bill Draft"), true);
    assert.equal(employeeWorkflowType("Fine"), true);
    assert.equal(employeeWorkflowType("Group Fine Request"), true);
    assert.equal(employeeWorkflowType("Loan"), true);
    assert.equal(employeeWorkflowType("Work Order LPO"), true);
    assert.equal(employeeWorkflowType("Work Order LPO Attachment"), true);
    assert.equal(employeeWorkflowType("Work Order LPO Approval"), true);
    assert.equal(employeeWorkflowType("Profile Incomplete"), false);
});

test("a new draft task records the employee it is assigned to", () => {
    const entry = createdHistoryEntry("Akhila Prasad", "Akhila Prasad");
    assert.equal(entry.event, "Created");
    assert.equal(entry.detail, "Created and assigned to Akhila Prasad.");
    assert.equal(entry.actorName, "Akhila Prasad");
});

test("the next employee is recorded when the assignee changes", () => {
    const same = assigneeHistoryEntry("Akhila Prasad", "Akhila Prasad");
    assert.equal(same, null);
    const next = assigneeHistoryEntry("Akhila Prasad", "Raseel Muhammad");
    assert.equal(next.event, "Reassigned");
    assert.equal(next.detail, "Reassigned from Akhila Prasad to Raseel Muhammad.");
    assert.equal(next.actorName, "Akhila Prasad");
});
