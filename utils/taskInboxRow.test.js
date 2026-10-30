import test from "node:test";
import assert from "node:assert/strict";
import { dedupeTaskInboxRows, inboxRowMatchesIds, isExpiryFollowUpTaskRow, isGeneralHubRequestType, taskInboxIdentity } from "./taskManagerModule.js";

test("expiry follow-up task notices are not vehicle bell rows", () => {
    assert.equal(
        isExpiryFollowUpTaskRow({
            extra1: "Expiry follow-up required: Mulkia (Registration) (Exp: 21/10/2026)",
        }),
        true,
    );
    assert.equal(isExpiryFollowUpTaskRow({ extra1: "Fortuner service pending" }), false);
});

test("general dashboard requests stay out of module bells", () => {
    assert.equal(isGeneralHubRequestType("Employee Asset Request"), true);
    assert.equal(isGeneralHubRequestType("Employee Salary Request"), true);
    assert.equal(isGeneralHubRequestType("Employee Certificate Request"), true);
    assert.equal(isGeneralHubRequestType("Employee Leave Request"), false);
    assert.equal(isGeneralHubRequestType("Employee Advance Request"), false);
    assert.equal(isGeneralHubRequestType("Employee Loan Request"), false);
    const notice = {
        dashboardActionId: "bell-1",
        extra3: JSON.stringify({ taskManagerId: "task-1", module: "tools" }),
    };
    assert.equal(inboxRowMatchesIds(notice, new Set(["task-1"])), true);
    assert.equal(inboxRowMatchesIds(notice, new Set(["other"])), false);
});

test("the same task is listed once", () => {
    const first = {
        dashboardActionId: "a",
        extra3: JSON.stringify({ taskManagerId: "task-1", taskKey: "action-1" }),
    };
    const second = {
        dashboardActionId: "b",
        extra3: JSON.stringify({ taskManagerId: "task-1", taskKey: "action-9" }),
    };
    const other = {
        dashboardActionId: "c",
        extra3: JSON.stringify({ taskManagerId: "task-2" }),
    };
    const rows = dedupeTaskInboxRows([first, second, other]);
    assert.deepEqual(rows.map((row) => row.dashboardActionId), ["a", "c"]);
    assert.equal(taskInboxIdentity(first), "task-1");
});
