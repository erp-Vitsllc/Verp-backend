import test from "node:test";
import assert from "node:assert/strict";
import { finishedOverlayBySource, overlayForListRow } from "./finishedTaskOverlay.js";

test("a completed task is kept for the list when the dashboard row is still open", () => {
    const rows = [{
        _id: "task-1",
        sourceDashboardActionId: "action-1",
        status: "Completed",
        taskType: "General Task",
        closeRequest: { closedAt: "2026-10-31T12:32:00.000Z", reviewPending: false },
        updatedAt: "2026-10-31T12:32:00.000Z",
    }];
    const finished = finishedOverlayBySource(rows, new Set());
    const overlay = overlayForListRow("action-1", new Map(), finished);
    assert.equal(overlay.status, "Completed");
    assert.equal(overlay.taskType, "General Task");
});

test("an open task stays ahead of an older finished copy", () => {
    const open = new Map([["action-1", { _id: "live", status: "Pending" }]]);
    const finished = finishedOverlayBySource([{
        _id: "old",
        sourceDashboardActionId: "action-1",
        status: "Completed",
    }], new Set());
    assert.equal(overlayForListRow("action-1", open, finished).status, "Pending");
});

test("a hidden cancelled copy does not close the live task", () => {
    const finished = finishedOverlayBySource([{
        _id: "copy",
        sourceDashboardActionId: "action-1",
        status: "Cancelled",
    }], new Set(["copy"]));
    assert.equal(overlayForListRow("action-1", new Map(), finished), null);
});

test("completed wins over a cancelled copy of the same task", () => {
    const finished = finishedOverlayBySource([
        {
            _id: "cancelled",
            sourceDashboardActionId: "action-1",
            status: "Cancelled",
            updatedAt: "2026-11-02T00:00:00.000Z",
        },
        {
            _id: "done",
            sourceDashboardActionId: "action-1",
            status: "Completed",
            updatedAt: "2026-10-31T00:00:00.000Z",
        },
    ], new Set());
    assert.equal(finished.get("action-1")._id, "done");
});

test("the newer completed row wins when two are finished", () => {
    const finished = finishedOverlayBySource([
        {
            _id: "older",
            sourceDashboardActionId: "action-1",
            status: "Completed",
            updatedAt: "2026-10-01T00:00:00.000Z",
        },
        {
            _id: "newer",
            sourceDashboardActionId: "action-1",
            status: "Completed",
            updatedAt: "2026-10-31T00:00:00.000Z",
        },
    ], new Set());
    assert.equal(finished.get("action-1")._id, "newer");
});
