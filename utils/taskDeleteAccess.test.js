import test from "node:test";
import assert from "node:assert/strict";
import { viewerMayDeleteTask } from "./taskDeleteAccess.js";
import { noticeKeysForRecord } from "./deletedTaskNotice.js";

const admin = { superUser: true, userId: "admin-1", name: "Admin", employeeId: "VITS000" };
const requester = { superUser: false, userId: "user-9", name: "Raseel Khan", employeeId: "VITS009" };
const other = { superUser: false, userId: "user-2", name: "Other Person", employeeId: "VITS002" };

test("admin super user can delete system and workflow tasks", () => {
    assert.equal(viewerMayDeleteTask(admin, { taskCategory: "Workflow Task" }), true);
    assert.equal(viewerMayDeleteTask(admin, { taskCategory: "Work Flow Task" }), true);
    assert.equal(viewerMayDeleteTask(admin, { taskCategory: "System Task" }), true);
    assert.equal(viewerMayDeleteTask(admin, { taskCategory: "General Task" }), false);
    assert.equal(viewerMayDeleteTask(admin, { taskCategory: "General Task", requestedByUserId: "admin-1" }), true);
    assert.equal(viewerMayDeleteTask(admin, { taskCategory: "System Task", closed: true }), false);
});

test("the requester can delete a general, system, or workflow task", () => {
    assert.equal(viewerMayDeleteTask(requester, {
        taskCategory: "General Task",
        requestedByUserId: "user-9",
        requestedByName: "Someone Else",
    }), true);
    assert.equal(viewerMayDeleteTask(requester, {
        taskCategory: "General Task",
        requestedByName: "Raseel Khan (VITS009)",
    }), true);
    assert.equal(viewerMayDeleteTask(other, {
        taskCategory: "General Task",
        requestedByName: "Raseel Khan (VITS009)",
    }), false);
    assert.equal(viewerMayDeleteTask(requester, {
        taskCategory: "Workflow Task",
        requestedByUserId: "user-9",
    }), true);
    assert.equal(viewerMayDeleteTask(requester, {
        taskCategory: "System Task",
        requestedByName: "Raseel Khan",
    }), true);
    assert.equal(viewerMayDeleteTask(other, {
        taskCategory: "Workflow Task",
        requestedByName: "Raseel Khan",
    }), false);
    assert.equal(viewerMayDeleteTask(requester, {
        taskCategory: "System Task",
        requestedByName: "System",
    }), false);
});

test("a deleted workflow notice keeps the request key", () => {
    const keys = noticeKeysForRecord({
        requestType: "Group Fine Request",
        requestId: "64b000000000000000000009",
        extra1: "Pay to employee",
    });
    assert.equal(keys.includes("TASK|Fine|64b000000000000000000009"), true);
    assert.equal(keys.includes("TASK|Fine|64b000000000000000000009|pay to employee"), true);
});

test("a deleted salary system task keeps the enrolment workflow key", () => {
    const reminder = noticeKeysForRecord({
        requestType: "Salary Enrollment",
        requestId: "64b000000000000000000010",
        subjectEmployeeId: "vits009",
        extra1: "Nivil Ali is pending for enrollment",
        extra2: "Pending for enrollment",
        extra3: JSON.stringify({ employeeId: "VITS009", pendingEnrollment: true }),
    });
    const workflow = noticeKeysForRecord({
        requestType: "Salary Enrollment",
        requestId: "64b000000000000000000011",
        subjectEmployeeId: "VITS009",
        extra1: "Nivil Ali (VITS009) enrolment waiting for HR approval.",
    });
    assert.equal(reminder.includes("SAL|VITS009|pending enrollment"), true);
    assert.equal(reminder.includes("TASK|Salary Enrollment|VITS009"), true);
    assert.equal(workflow.includes("SAL|VITS009|pending enrollment"), true);
    assert.equal(workflow.includes("TASK|Salary Enrollment|VITS009"), true);
});

test("a deleted employee expiry notice keeps the same bell key", () => {
    const keys = noticeKeysForRecord({
        requestType: "Employee Document Expiry Reminder",
        requestId: "64b000000000000000000001",
        subjectEmployeeId: "VITS009",
        extra1: "Expiry follow-up required: Passport (Exp: 01/01/2026)",
    });
    assert.equal(
        keys[0],
        "EDE|VITS009|expiry follow-up required: passport (exp: 01/01/2026)",
    );
});
