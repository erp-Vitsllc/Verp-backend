import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    applyStableTaskNumbers,
    assignTaskNumbers,
    canonicalTaskNumber,
    earlierTaskNumber,
    firstStoredTaskNumber,
    formatTaskNumber,
    listedNumberAfterRefresh,
    parseTaskNumber,
} from "./taskNumber.js";

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

describe("parseTaskNumber", () => {
    it("accepts a saved task number", () => {
        assert.deepEqual(parseTaskNumber("TSK-26-218"), { year: "26", count: 218 });
        assert.equal(parseTaskNumber(""), null);
        assert.equal(parseTaskNumber("task 218"), null);
        assert.equal(firstStoredTaskNumber("", "TSK-26-216", "TSK-26-218"), "TSK-26-216");
        assert.equal(earlierTaskNumber("TSK-26-218", "TSK-26-216"), "TSK-26-216");
    });
});

describe("listedNumberAfterRefresh", () => {
    it("keeps the number already stored on that task", () => {
        const kept = listedNumberAfterRefresh("TSK-26-977", "TSK-26-982", "TSK-26-977");
        assert.equal(kept.taskNumber, "TSK-26-982");
        assert.equal(kept.numberSaved, true);
        assert.equal(kept.copySaved, true);
        const own = listedNumberAfterRefresh("", "TSK-26-982", "");
        assert.equal(own.taskNumber, "TSK-26-982");
        assert.equal(own.numberSaved, true);
    });

    it("uses the task copy only when that task has no number yet", () => {
        const fromCopy = listedNumberAfterRefresh("", "", "TSK-26-977");
        assert.equal(fromCopy.taskNumber, "TSK-26-977");
        assert.equal(fromCopy.numberSaved, false);
        assert.equal(fromCopy.copySaved, true);
        assert.equal(canonicalTaskNumber("TSK-26-982"), "TSK-26-982");
    });
});

describe("applyStableTaskNumbers", () => {
    it("matches the list order the first time numbers are saved", () => {
        const tasks = [
            { actionId: "b", requestDate: "2026-10-10T08:00:00.000Z" },
            { actionId: "a", requestDate: "2026-10-01T08:00:00.000Z" },
            { actionId: "c", requestDate: "2025-12-01T08:00:00.000Z" },
        ];
        applyStableTaskNumbers(tasks);
        const byId = new Map(tasks.map((task) => [task.actionId, task.taskNumber]));
        assert.equal(byId.get("a"), "TSK-26-1");
        assert.equal(byId.get("b"), "TSK-26-2");
        assert.equal(byId.get("c"), "TSK-25-1");
    });

    it("keeps a saved number when an older task is added", () => {
        const tasks = [
            { actionId: "saved", requestDate: "2026-10-31T08:00:00.000Z", taskNumber: "TSK-26-218" },
            { actionId: "older", requestDate: "2026-10-01T08:00:00.000Z", taskNumber: "" },
        ];
        applyStableTaskNumbers(tasks, { nextCountByYear: new Map([["26", 218]]) });
        assert.equal(tasks[0].taskNumber, "TSK-26-218");
        assert.equal(tasks[1].taskNumber, "TSK-26-219");
    });
});
