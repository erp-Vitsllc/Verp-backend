import test from "node:test";
import assert from "node:assert/strict";
import {
    OLD_EXPIRY_STILL_SAME_MESSAGE,
    SOURCE_STILL_PENDING_MESSAGE,
    classifyWorkStatus,
    combineSourceStatus,
    expiryFollowUpState,
    serviceStageState,
    sourceGateApplies,
} from "./sourceTaskCompletionRules.js";

const visitReminder = "Expiry follow-up required: Visit Visa (Exp: 01/11/2026)";

test("a visit visa on the same expiry stays pending", () => {
    const status = expiryFollowUpState({
        reminderText: visitReminder,
        liveDocs: [{ label: "Visit Visa", expiryDate: new Date("2026-11-01T00:00:00.000Z") }],
    });
    assert.equal(status, "Pending");
});

test("a renewed visit visa is completed and a removed visa is closed", () => {
    assert.equal(expiryFollowUpState({
        reminderText: visitReminder,
        liveDocs: [{ label: "Visit Visa", expiryDate: new Date("2027-11-01T00:00:00.000Z") }],
    }), "Completed");
    assert.equal(expiryFollowUpState({
        reminderText: visitReminder,
        liveDocs: [{ label: "Passport", expiryDate: new Date("2026-11-01T00:00:00.000Z") }],
    }), "Closed");
    assert.equal(expiryFollowUpState({
        reminderText: visitReminder,
        liveDocs: [],
    }), "Closed");
});

test("a renew is confirmed only when the expiry date changes", () => {
    const oldCard = { label: "Visit Visa", expiryDate: new Date("2026-11-01T00:00:00.000Z") };
    assert.equal(expiryFollowUpState({
        reminderText: visitReminder,
        liveDocs: [],
        oldDocs: [oldCard],
    }), "Pending");
    assert.equal(expiryFollowUpState({
        reminderText: visitReminder,
        liveDocs: [{ label: "Visit Visa", expiryDate: new Date("2027-11-01T00:00:00.000Z") }],
        oldDocs: [oldCard],
    }), "Completed");
    assert.equal(expiryFollowUpState({
        reminderText: "Expiry follow-up required: Passport (Exp: 01/11/2026)",
        liveDocs: [],
        oldDocs: [{ label: "Passport", expiryDate: new Date("2026-11-01T00:00:00.000Z"), notRenewed: true }],
    }), "Closed");
    assert.equal(expiryFollowUpState({
        reminderText: "Expiry follow-up required: Emirates ID (Exp: 15/12/2026)",
        liveDocs: [{ label: "Emirates ID", expiryDate: new Date("2026-12-15T00:00:00.000Z") }],
    }), "Pending");
    assert.match(OLD_EXPIRY_STILL_SAME_MESSAGE, /same expiry date/);
    assert.match(OLD_EXPIRY_STILL_SAME_MESSAGE, /confirm/i);
});

test("another person's visit visa label does not close this card", () => {
    assert.equal(expiryFollowUpState({
        reminderText: visitReminder,
        liveDocs: [{ label: "Ahmed - Visit Visa", expiryDate: new Date("2027-01-01T00:00:00.000Z") }],
    }), "Closed");
});

test("service and workflow statuses allow only a finished source", () => {
    assert.equal(serviceStageState("pending_hr"), "Pending");
    assert.equal(serviceStageState("pending_accounts"), "Pending");
    assert.equal(serviceStageState("scheduled_service"), "Pending");
    assert.equal(serviceStageState(""), "Pending");
    assert.equal(serviceStageState("complete"), "Completed");
    assert.equal(serviceStageState("billed"), "Completed");
    assert.equal(serviceStageState("rejected"), "Closed");
    assert.equal(classifyWorkStatus("Pending Due"), "pending");
    assert.equal(classifyWorkStatus("On Hold"), "pending");
    assert.equal(classifyWorkStatus("In Progress"), "pending");
    assert.equal(combineSourceStatus("Pending", "Approved"), "Pending");
    assert.equal(combineSourceStatus("Approved", "Pending"), "Completed");
    assert.equal(combineSourceStatus("Rejected", "Pending"), "Closed");
    assert.equal(combineSourceStatus("", "Pending"), "Pending");
    assert.equal(combineSourceStatus("", "Dismissed"), "Closed");
    assert.equal(combineSourceStatus("Active", "Pending"), "Completed");
});

test("the gate is for system and workflow tasks that point at a real record", () => {
    const action = { requestType: "Employee Document Expiry Reminder" };
    assert.equal(sourceGateApplies({ taskType: "System Task" }, action), true);
    assert.equal(sourceGateApplies({ taskType: "Work Flow Task" }, action), true);
    assert.equal(sourceGateApplies({ taskType: "General Task" }, action), false);
    assert.equal(sourceGateApplies({ taskType: "System Task" }, { requestType: "Task Manager" }), false);
    assert.equal(sourceGateApplies({ taskType: "System Task" }, null), false);
    assert.match(SOURCE_STILL_PENDING_MESSAGE, /already on Pending/);
    assert.match(SOURCE_STILL_PENDING_MESSAGE, /Completed or Closed/);
});
