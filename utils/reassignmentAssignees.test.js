import assert from "node:assert/strict";
import test from "node:test";
import { latestReassignedAt, reassignmentAssignees } from "./taskManagerModule.js";

test("reassignment keeps the original assignee as the main name", () => {
    const pair = reassignmentAssignees({
        assigneeName: "Akhila Prasad",
        originalAssigneeName: "Raseel Muhammad",
    });
    assert.equal(pair.mainAssigneeName, "Raseel Muhammad");
    assert.equal(pair.reassignedAssigneeName, "Akhila Prasad");
});

test("a task that was not reassigned has one assignee", () => {
    const pair = reassignmentAssignees({
        assigneeName: "Raseel Muhammad",
        originalAssigneeName: "",
    });
    assert.equal(pair.mainAssigneeName, "Raseel Muhammad");
    assert.equal(pair.reassignedAssigneeName, "");
});

test("the latest reassignment date is the one used for ordering", () => {
    const at = latestReassignedAt({
        history: [
            { event: "Reassigned", createdAt: "2026-10-12T08:00:00.000Z" },
            { event: "Edited", createdAt: "2026-10-20T08:00:00.000Z" },
            { event: "Reassigned", createdAt: "2026-10-28T06:30:00.000Z" },
        ],
    });
    assert.equal(at, "2026-10-28T06:30:00.000Z");
    assert.equal(latestReassignedAt({ history: [] }), "");
});

test("returned task shows the original assignee only", () => {
    const pair = reassignmentAssignees({
        assigneeName: "Raseel Muhammad",
        originalAssigneeName: "Raseel Muhammad",
    });
    assert.equal(pair.mainAssigneeName, "Raseel Muhammad");
    assert.equal(pair.reassignedAssigneeName, "");
});
