import test from "node:test";
import assert from "node:assert/strict";
import { isPendingEnrollmentReminder } from "./pendingEnrollmentReminder.js";

test("a pending enrollment reminder is recognized from its label or marker", () => {
    assert.equal(isPendingEnrollmentReminder({ extra2: "Pending for enrollment" }), true);
    assert.equal(
        isPendingEnrollmentReminder({
            extra2: "Enrolment waiting for HR",
            extra3: JSON.stringify({ pendingEnrollment: true, employeeId: "VEGA-HR-0101" }),
        }),
        true,
    );
    assert.equal(
        isPendingEnrollmentReminder({
            extra2: "Enrolment waiting for HR",
            extra3: JSON.stringify({ employeeId: "VEGA-HR-0101" }),
        }),
        false,
    );
});
