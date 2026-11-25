import test from "node:test";
import assert from "node:assert/strict";
import { canDecideDateChange, dateChangeActorRole, dateChangeMailTargets } from "./taskDateChange.js";

const parties = {
    requester: "requester@company.test",
    assignee: "assignee@company.test",
    reassignee: "reassignee@company.test",
};

test("change date is limited to the requester, then the reassignee, then the assignee", () => {
    assert.equal(dateChangeActorRole({ requester: true, assignee: true, reassignee: true }), "requester");
    assert.equal(dateChangeActorRole({ assignee: true, reassignee: true }), "assignee");
    assert.equal(dateChangeActorRole({ reassignee: true }), "reassignee");
    assert.equal(dateChangeActorRole({ assignee: true }), "assignee");
    assert.equal(dateChangeActorRole({}), "");
});

test("assignee date changes are approved by the requester, reassignee date changes by the assignee", () => {
    assert.equal(canDecideDateChange({ requester: true, requestRole: "assignee" }), true);
    assert.equal(canDecideDateChange({ assignee: true, requestRole: "assignee" }), false);
    assert.equal(canDecideDateChange({ reassignee: true, requestRole: "assignee" }), false);
    assert.equal(canDecideDateChange({ assignee: true, requestRole: "reassignee" }), true);
    assert.equal(canDecideDateChange({ requester: true, assignee: true, requestRole: "reassignee" }), true);
    assert.equal(canDecideDateChange({ requester: true, requestRole: "reassignee" }), false);
    assert.equal(canDecideDateChange({ requester: true, requestRole: "requester" }), false);
});

test("company mail follows the requester, assignee, and reassignee rules", () => {
    assert.deepEqual(dateChangeMailTargets("requester-changed", parties), [
        "requester@company.test",
        "assignee@company.test",
        "reassignee@company.test",
    ]);
    assert.deepEqual(dateChangeMailTargets("requester-changed", {
        requester: "requester@company.test",
        assignee: "assignee@company.test",
        reassignee: "",
    }), [
        "requester@company.test",
        "assignee@company.test",
    ]);
    assert.deepEqual(dateChangeMailTargets("assignee-requested", parties), ["requester@company.test"]);
    assert.deepEqual(dateChangeMailTargets("reassignee-requested", parties), ["assignee@company.test"]);
    assert.deepEqual(dateChangeMailTargets("assignee-approved", parties), [
        "assignee@company.test",
        "reassignee@company.test",
    ]);
    assert.deepEqual(dateChangeMailTargets("reassignee-approved", parties), [
        "requester@company.test",
        "reassignee@company.test",
    ]);
    assert.deepEqual(dateChangeMailTargets("assignee-rejected", parties), ["assignee@company.test"]);
    assert.deepEqual(dateChangeMailTargets("reassignee-rejected", parties), ["reassignee@company.test"]);
    assert.deepEqual(dateChangeMailTargets("requester-changed", {
        requester: "same@company.test",
        assignee: "same@company.test",
        reassignee: " ",
    }), ["same@company.test"]);
    assert.deepEqual(dateChangeMailTargets("other", parties), []);
});
