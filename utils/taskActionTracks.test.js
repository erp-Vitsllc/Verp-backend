import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildActionTracks } from "./taskActionTracks.js";

function titles(steps) {
    return steps.map((step) => [step.title, step.status, step.detail]);
}

describe("task action history", () => {
    it("shows who requested the task and who it was assigned to", () => {
        const steps = buildActionTracks({
            requesterName: "System",
            assigneeName: "NESMI SHAMSUDEEN",
            status: "In Progress",
            requestDate: "2026-11-01T08:00:00.000Z",
        });
        assert.deepEqual(titles(steps), [
            ["Requested by System", "Completed", "Task created"],
            ["Assigned to NESMI SHAMSUDEEN", "In Progress", "From System"],
        ]);
        assert.equal(steps.some((step) => /hr|reportee|completed/i.test(step.title) && step.status === "Not Started"), false);
    });

    it("keeps a rejection in the list and shows who it was returned to", () => {
        const steps = buildActionTracks({
            requesterName: "System",
            assigneeName: "NESMI SHAMSUDEEN",
            originalAssigneeName: "NESMI SHAMSUDEEN",
            status: "In Progress",
            history: [
                {
                    event: "Reassigned",
                    detail: "Reassigned from NESMI SHAMSUDEEN to Raseel Muhammad. Covering leave.",
                    actorName: "NESMI SHAMSUDEEN",
                    createdAt: "2026-11-02T04:00:00.000Z",
                },
                {
                    event: "Rejected",
                    detail: "Raseel Muhammad rejected this task. Please correct the limit.",
                    actorName: "Raseel Muhammad",
                    createdAt: "2026-11-02T05:00:00.000Z",
                },
            ],
        });
        assert.deepEqual(titles(steps), [
            ["Requested by System", "Completed", "Task created"],
            ["Assigned to NESMI SHAMSUDEEN", "Completed", "From System"],
            ["Reassigned to Raseel Muhammad", "Completed", "From NESMI SHAMSUDEEN"],
            ["Rejected by Raseel Muhammad", "Rejected", "Returned to NESMI SHAMSUDEEN. Please correct the limit."],
            ["Returned to NESMI SHAMSUDEEN", "In Progress", "Rejected by Raseel Muhammad"],
        ]);
    });

    it("keeps a final rejection and does not add later steps", () => {
        const steps = buildActionTracks({
            requesterName: "Ali Khan",
            assigneeName: "NESMI SHAMSUDEEN",
            status: "Rejected",
            history: [
                {
                    event: "Rejected",
                    detail: "Ali Khan rejected this task. The status is Rejected.",
                    actorName: "Ali Khan",
                    createdAt: "2026-11-02T05:00:00.000Z",
                },
            ],
        });
        assert.deepEqual(steps.map((step) => step.status), ["Completed", "Completed", "Rejected"]);
        assert.equal(steps.at(-1).title, "Rejected by Ali Khan");
        assert.equal(steps.some((step) => step.status === "In Progress" || step.status === "Not Started"), false);
    });

    it("shows an acceptance and the person it was sent to", () => {
        const steps = buildActionTracks({
            requesterName: "System",
            assigneeName: "Raseel Muhammad",
            originalAssigneeName: "NESMI SHAMSUDEEN",
            status: "In Progress",
            history: [
                {
                    event: "Approved",
                    detail: "NESMI SHAMSUDEEN accepted. Sent to Raseel Muhammad.",
                    actorName: "NESMI SHAMSUDEEN",
                    createdAt: "2026-11-02T06:00:00.000Z",
                },
            ],
        });
        assert.deepEqual(titles(steps), [
            ["Requested by System", "Completed", "Task created"],
            ["Assigned to NESMI SHAMSUDEEN", "Completed", "From System"],
            ["Accepted by NESMI SHAMSUDEEN", "Accepted", "Sent to Raseel Muhammad"],
            ["Assigned to Raseel Muhammad", "In Progress", "Accepted by NESMI SHAMSUDEEN"],
        ]);
    });

    it("does not show a later approver until that person has the task", () => {
        const steps = buildActionTracks({
            requesterName: "System",
            assigneeName: "Ali Khan",
            status: "In Progress",
            change: {
                stage: "pending_reportee",
                reporteeName: "Ali Khan",
                hrName: "Sara Ali",
            },
        });
        assert.deepEqual(steps.map((step) => step.title), [
            "Requested by System",
            "Assigned to Ali Khan",
        ]);
        assert.equal(steps.some((step) => /hr|reportee/i.test(step.title)), false);
    });

    it("shows the acceptance that moved the task, by the person who acted", () => {
        const steps = buildActionTracks({
            requesterName: "System",
            assigneeName: "Sara Ali",
            status: "In Progress",
            change: {
                stage: "pending_hr",
                reporteeName: "Ali Khan",
                hrName: "Sara Ali",
                decidedAtReportee: "2026-11-02T04:00:00.000Z",
            },
        });
        assert.deepEqual(titles(steps), [
            ["Requested by System", "Completed", "Task created"],
            ["Assigned to Ali Khan", "Completed", "From System"],
            ["Accepted by Ali Khan", "Accepted", "Sent to Sara Ali"],
            ["Assigned to Sara Ali", "In Progress", "Accepted by Ali Khan"],
        ]);
    });

    it("keeps each rejection when the task is rejected more than once", () => {
        const steps = buildActionTracks({
            requesterName: "System",
            assigneeName: "NESMI SHAMSUDEEN",
            status: "In Progress",
            history: [
                {
                    event: "Rejected",
                    detail: "Sara Ali rejected this task. Fix the amount.",
                    actorName: "Sara Ali",
                    createdAt: "2026-11-02T04:00:00.000Z",
                },
                {
                    event: "Rejected",
                    detail: "Raseel Muhammad rejected this task. Still wrong.",
                    actorName: "Raseel Muhammad",
                    createdAt: "2026-11-02T08:00:00.000Z",
                },
            ],
        });
        assert.deepEqual(
            steps.filter((step) => step.status === "Rejected").map((step) => step.title),
            ["Rejected by Sara Ali", "Rejected by Raseel Muhammad"],
        );
    });

    it("keeps both the acceptance and the later rejection", () => {
        const steps = buildActionTracks({
            requesterName: "System",
            assigneeName: "Sara Ali",
            status: "Cancelled",
            change: {
                stage: "rejected",
                reporteeName: "Ali Khan",
                hrName: "Sara Ali",
                rejectedByName: "Sara Ali",
                decidedAtReportee: "2026-11-02T04:00:00.000Z",
                decidedAtHr: "2026-11-02T05:00:00.000Z",
            },
        });
        assert.deepEqual(steps.map((step) => [step.title, step.status]), [
            ["Requested by System", "Completed"],
            ["Assigned to Ali Khan", "Completed"],
            ["Accepted by Ali Khan", "Accepted"],
            ["Assigned to Sara Ali", "Completed"],
            ["Rejected by Sara Ali", "Rejected"],
        ]);
    });
});
