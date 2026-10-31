import assert from "node:assert/strict";
import test from "node:test";
import {
    actionMatchesFilters,
    isOpenReassignedTask,
    publicActionMeta,
    viewerIsTaskAssignee,
} from "./reassigneeTaskPower.js";

test("an open reassigned task still belongs to the new assignee", () => {
    assert.equal(isOpenReassignedTask({
        status: "In Progress",
        closeRequest: { originalAssigneeId: "orig", originalAssigneeName: "Accounts User" },
    }), true);
});

test("a released or closed reassignment does not keep the extra power", () => {
    assert.equal(isOpenReassignedTask({
        status: "In Progress",
        closeRequest: { originalAssigneeName: "Accounts User", reassignmentReleased: true },
    }), false);
    assert.equal(isOpenReassignedTask({
        status: "Completed",
        closeRequest: { originalAssigneeName: "Accounts User" },
    }), false);
    assert.equal(isOpenReassignedTask({
        status: "In Progress",
        closeRequest: {},
    }), false);
});

test("the current assignee matches by employee id or employee code", () => {
    const task = { assignee: "emp-1", assigneeEmpId: "VITS010" };
    assert.equal(viewerIsTaskAssignee(task, { employeeObjectId: "emp-1" }), true);
    assert.equal(viewerIsTaskAssignee(task, { employeeId: "vits010" }), true);
    assert.equal(viewerIsTaskAssignee(task, { employeeObjectId: "someone-else" }), false);
});

test("a service filter only matches that service row", () => {
    const action = {
        requestType: "Vehicle Service Request",
        extra3: JSON.stringify({ serviceRecordId: "svc-1" }),
    };
    assert.equal(actionMatchesFilters(action, { serviceId: "svc-1" }), true);
    assert.equal(actionMatchesFilters(action, { serviceId: "svc-2" }), false);
    assert.equal(actionMatchesFilters(action, { requestType: "Fine" }), false);
});

test("disposition role is read from the task meta", () => {
    const extra3 = JSON.stringify({ dispositionViewerRole: "accounts", vehicleMongoId: "veh-1" });
    assert.equal(publicActionMeta(extra3).dispositionViewerRole, "accounts");
    assert.equal(actionMatchesFilters(
        { requestType: "Vehicle Disposition Request", extra3 },
        { requestType: "Vehicle Disposition Request", metaField: "dispositionViewerRole", metaValue: "accounts" },
    ), true);
    assert.equal(actionMatchesFilters(
        { requestType: "Vehicle Disposition Request", extra3 },
        { metaField: "dispositionViewerRole", metaValue: "hr" },
    ), false);
});
