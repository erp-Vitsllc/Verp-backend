import assert from "node:assert/strict";
import test from "node:test";
import {
    createdHistoryEntry,
    employeeWorkflowType,
    handoffHistoryEntries,
    isAutomaticWorkflowHandoff,
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
    assert.deepEqual(handoffHistoryEntries("Akhila Prasad", "Akhila Prasad"), []);
    const next = handoffHistoryEntries("Akhila Prasad", "Raseel Muhammad");
    assert.equal(next[0].event, "Completed");
    assert.equal(next[0].detail, "Task completed by Akhila Prasad.");
    assert.equal(next[0].actorName, "Akhila Prasad");
    assert.equal(next[1].event, "Assigned");
    assert.equal(next[1].detail, "Assigned automatically to Raseel Muhammad.");
    assert.equal(next[1].actorName, "Akhila Prasad");
});

test("automatic handoff history is for workflow tasks", () => {
    assert.equal(isAutomaticWorkflowHandoff("Vehicle Service Request"), true);
    assert.equal(isAutomaticWorkflowHandoff("Employee Leave Request"), true);
    assert.equal(isAutomaticWorkflowHandoff("Delivery Approval"), true);
    assert.equal(isAutomaticWorkflowHandoff("Employee Salary Request"), false);
    assert.equal(isAutomaticWorkflowHandoff("Profile Incomplete"), false);
    assert.equal(isAutomaticWorkflowHandoff("Task Manager"), false);
});
