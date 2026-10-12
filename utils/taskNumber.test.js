import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assignTaskNumbers, formatTaskNumber } from "./taskNumber.js";

describe("formatTaskNumber", () => {
    it("uses the year and the count", () => {
        assert.equal(formatTaskNumber("2026", 925), "TSK-26-925");
        assert.equal(formatTaskNumber("2025", 7), "TSK-25-7");
    });
});

describe("assignTaskNumbers", () => {
    it("counts within the year in request order", () => {
        const tasks = [
            { actionId: "b", requestDate: "2026-10-10T08:00:00.000Z" },
            { actionId: "a", requestDate: "2026-10-01T08:00:00.000Z" },
            { actionId: "c", requestDate: "2025-12-01T08:00:00.000Z" },
        ];
        assignTaskNumbers(tasks);
        const byId = new Map(tasks.map((task) => [task.actionId, task.taskNumber]));
        assert.equal(byId.get("a"), "TSK-26-1");
        assert.equal(byId.get("b"), "TSK-26-2");
        assert.equal(byId.get("c"), "TSK-25-1");
    });
});
