import assert from "node:assert/strict";
import test from "node:test";
import { isLeaveAttendanceTaskType } from "./ensureRequestTask.js";
import { moduleForRequestType } from "./taskManagerModule.js";

test("every leave and attendance request type is marked for its own task", () => {
    for (const type of [
        "Employee Leave Request",
        "Attendance Leave Request",
        "Attendance Change Request",
        "Hour Approval Request",
        "Flexible OT Request",
        "Attendance Off Day Work",
    ]) {
        assert.equal(isLeaveAttendanceTaskType(type), true, type);
    }
    assert.equal(isLeaveAttendanceTaskType("Fine"), false);
    assert.equal(isLeaveAttendanceTaskType("Task Manager"), false);
});

test("leave stays on leave, and attendance requests stay on attendance", () => {
    assert.equal(moduleForRequestType("Employee Leave Request").module, "leave");
    assert.equal(moduleForRequestType("Attendance Leave Request").module, "attendance");
    assert.equal(moduleForRequestType("Attendance Change Request").module, "attendance");
    assert.equal(moduleForRequestType("Hour Approval Request").module, "attendance");
    assert.equal(moduleForRequestType("Flexible OT Request").module, "attendance");
    assert.equal(moduleForRequestType("Attendance Off Day Work").module, "attendance");
});
