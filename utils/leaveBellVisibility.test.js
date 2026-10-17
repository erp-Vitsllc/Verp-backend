import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { leaveRangeOf, selectOpenLeaveBellItems } from "./leaveBellVisibility.js";

const TODAY = "2026-10-17";

describe("leave bell visibility", () => {
    it("reads a written leave range from the request text", () => {
        const range = leaveRangeOf({
            extra1: "I would like to request annual leave from August 31 to September 3. Thank you.",
            requestedDate: "2026-08-15T08:35:00.000Z",
        }, TODAY);
        assert.equal(range.start, "2026-08-31");
        assert.equal(range.end, "2026-09-03");
    });

    it("keeps a pending request that has not ended", () => {
        const [kept] = selectOpenLeaveBellItems([
            {
                id: "open",
                status: "Pending",
                employeeMongoId: "emp-1",
                startDateKey: "2026-10-21",
                endDateKey: "2026-10-21",
            },
        ], { today: TODAY });
        assert.equal(kept.id, "open");
    });

    it("drops old requests and requests that were accepted, rejected, or deleted", () => {
        const kept = selectOpenLeaveBellItems([
            {
                id: "old-hub",
                status: "Pending",
                hubRequest: true,
                employeeMongoId: "melvin",
                extra1: "I would like to request annual leave from August 31 to September 3. Thank you.",
                requestedDate: "2026-08-15T08:35:00.000Z",
            },
            {
                id: "accepted",
                status: "Approved",
                employeeMongoId: "emp-2",
                startDateKey: "2026-10-21",
                endDateKey: "2026-10-21",
            },
            {
                id: "rejected",
                status: "Rejected",
                startDateKey: "2026-10-22",
                endDateKey: "2026-10-22",
            },
            {
                id: "deleted",
                status: "Deleted",
                startDateKey: "2026-10-23",
                endDateKey: "2026-10-23",
            },
            {
                id: "already-decided",
                status: "Pending",
                hubRequest: true,
                employeeMongoId: "netra",
                startDateKey: "2026-10-21",
                endDateKey: "2026-10-21",
            },
            {
                id: "still-open",
                status: "Pending",
                employeeMongoId: "netra",
                startDateKey: "2026-11-02",
                endDateKey: "2026-11-02",
            },
        ], {
            today: TODAY,
            pendingRanges: [{ employeeMongoId: "netra", from: "2026-11-02", to: "2026-11-02" }],
            decidedRanges: [{ employeeMongoId: "netra", from: "2026-10-21", to: "2026-10-21" }],
        });
        assert.deepEqual(kept.map((item) => item.id), ["still-open"]);
    });
});
