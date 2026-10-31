import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { waitingStepsFromFacts } from "./taskWaitingSteps.js";

describe("waiting steps", () => {
    it("names HR while that approval is the current step", () => {
        const steps = waitingStepsFromFacts(
            { displayStatus: "Pending", assigneeName: "Raseel Muhammad", requestType: "Hour Approval Request" },
            { stage: "pending_hr", hrName: "Raseel Muhammad", reporteeName: "Ali Khan" },
        );
        assert.equal(steps.find((step) => step.status === "In Progress").key, "hr");
        assert.equal(steps.find((step) => step.status === "In Progress").personName, "Raseel Muhammad");
        assert.equal(steps.find((step) => step.key === "reportee").status, "Completed");
    });

    it("keeps a later HR approval when the reportee is still waiting", () => {
        const steps = waitingStepsFromFacts(
            { displayStatus: "Pending", assigneeName: "Ali Khan" },
            { stage: "pending_reportee", reporteeName: "Ali Khan", hrName: "Sara Ali" },
        );
        assert.deepEqual(
            steps.map((step) => [step.status, step.approvalTitle, step.personName]),
            [
                ["In Progress", "Reportee Approval", "Ali Khan"],
                ["Not Started", "HR Approval", "Sara Ali"],
            ],
        );
    });

    it("waits on the original assignee after the reassignee completes", () => {
        const steps = waitingStepsFromFacts(
            {
                displayStatus: "Pending",
                completionPending: true,
                originalAssigneeName: "Vishnu Prasad",
                reassignedAssigneeName: "Raseel Muhammad",
                assigneeName: "Raseel Muhammad",
            },
            { stage: "pending_hr", hrName: "Raseel Muhammad", reporteeName: "Ali Khan" },
        );
        assert.equal(steps[0].personName, "Vishnu Prasad");
        assert.equal(steps.some((step) => step.personName === "Raseel Muhammad"), false);
    });

    it("adds a different approval that is still waiting after completion is submitted", () => {
        const steps = waitingStepsFromFacts(
            {
                displayStatus: "Pending",
                completionPending: true,
                originalAssigneeName: "Vishnu Prasad",
                reassignedAssigneeName: "Raseel Muhammad",
            },
            { stage: "pending_reportee", reporteeName: "Raseel Muhammad", hrName: "Sara Ali" },
        );
        assert.deepEqual(steps.map((step) => step.personName), ["Vishnu Prasad", "Sara Ali"]);
    });

    it("hides the line once the task is finished", () => {
        assert.deepEqual(waitingStepsFromFacts({ displayStatus: "Completed", assigneeName: "Raseel Muhammad" }), []);
    });
});
