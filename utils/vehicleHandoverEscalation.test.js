import test from "node:test";
import assert from "node:assert/strict";
import {
    bodyConditionReportHasAnyPhoto,
    handoverImagesMissingMessage,
    handoverMissingImagesDecision,
} from "./vehicleHandoverEscalation.js";
import { isAutomaticWorkflowHandoff } from "./employeeWorkflowTask.js";
import { formatTaskDisplayParts } from "./taskDisplayName.js";
import { composeTaskDescription } from "./taskDetailDescription.js";
import { taskCategory } from "../controllers/stats/getTaskManagerNotifications.js";

const previousPhoto = {
    frontView: { photo: "https://cdn.example/front.jpg" },
};

test("day 10 stops when body images were not added, even if a previous photo exists", () => {
    const decision = handoverMissingImagesDecision({}, previousPhoto);
    assert.equal(decision.block, true);
    assert.equal(decision.photosAdded, false);
    assert.equal(decision.noPreviousPhoto, false);
    assert.equal(
        handoverImagesMissingMessage(decision),
        "Images were not added. This handover cannot go to the next step. Do not update without images.",
    );
});

test("day 10 stops when there is no previous image and none were added", () => {
    const decision = handoverMissingImagesDecision({}, null);
    assert.equal(decision.block, true);
    assert.equal(decision.noPreviousPhoto, true);
    assert.match(handoverImagesMissingMessage(decision), /no previous image/);
    assert.match(handoverImagesMissingMessage(decision), /Do not update without images/);
});

test("day 10 can continue when the body condition images are already on the handover", () => {
    const decision = handoverMissingImagesDecision(
        { bodyConditionCompleted: true },
        null,
    );
    assert.equal(decision.block, false);
    assert.equal(decision.photosAdded, true);
    assert.equal(bodyConditionReportHasAnyPhoto(previousPhoto), true);
    assert.equal(bodyConditionReportHasAnyPhoto({ frontView: { comment: "scratch" } }), false);
});

test("the missing-image notice is a vehicle system task for the admin officer", () => {
    assert.equal(isAutomaticWorkflowHandoff("Vehicle Handover Images Missing"), false);
    assert.equal(taskCategory("Vehicle Handover Images Missing"), "System Task");
    const name = formatTaskDisplayParts({
        requestType: "Vehicle Handover Images Missing",
        extra1: "VEGA-VEH-1 — Hilux",
        extra2: handoverImagesMissingMessage({ noPreviousPhoto: true }),
        vehicleNo: "Dubai A 12345",
    });
    assert.equal(name.title, "Handover Images Missing");
    assert.equal(name.subject, "Dubai A 12345");
    const description = composeTaskDescription({
        requestType: "Vehicle Handover Images Missing",
        extra2: handoverImagesMissingMessage({}),
        comment: handoverImagesMissingMessage({}),
    });
    assert.match(description, /Add the body condition images/);
    assert.match(description, /Do not update without images/);
});
