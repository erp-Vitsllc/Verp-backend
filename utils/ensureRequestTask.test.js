import assert from "node:assert/strict";
import test from "node:test";
import { applyAssigneeFollow, isLeaveAttendanceTaskType } from "./ensureRequestTask.js";
import { holderForLeaveAttendanceAction } from "./ensureOpenLeaveAttendanceTasks.js";
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

test("a leave or attendance task follows the employee who now holds the request", () => {
    const task = {
        assignee: "raseel",
        assigneeEmpId: "HR-1",
        assigneeName: "Raseel Muhammad",
        closeRequest: { originalAssigneeName: "Someone", returnAssigneeName: "Raseel Muhammad" },
        history: [],
    };
    assert.equal(applyAssigneeFollow(task, {
        assigneeId: "nesmi",
        assigneeEmpId: "HR-2",
        assigneeName: "Nesmi",
    }), true);
    assert.equal(task.assignee, "nesmi");
    assert.equal(task.assigneeName, "Nesmi");
    assert.equal(task.closeRequest.originalAssigneeName, "");
    assert.equal(task.closeRequest.returnAssigneeName, "");
    assert.equal(task.history[0].event, "Completed");
    assert.equal(task.history[0].detail, "Task completed by Raseel Muhammad.");
    assert.equal(task.history[1].event, "Assigned");
    assert.equal(task.history[1].detail, "Assigned automatically to Nesmi.");
    assert.equal(applyAssigneeFollow(task, { assigneeId: "nesmi", assigneeName: "Nesmi" }), false);
});

test("the current attendance hand is the task assignee", () => {
    const change = { stage: "pending_hr", hrId: "nesmi", reporteeId: "raseel" };
    assert.equal(holderForLeaveAttendanceAction({
        requestType: "Flexible OT Request",
        change,
    }), "nesmi");
    assert.equal(holderForLeaveAttendanceAction({
        requestType: "Employee Leave Request",
        change,
        leaveRow: { leaveApprovalStage: "pending_reportee" },
        reporteeId: "raseel",
        hrId: "nesmi",
    }), "nesmi");
    assert.equal(holderForLeaveAttendanceAction({
        requestType: "Employee Leave Request",
        leaveRow: { leaveApprovalStage: "pending_reportee" },
        reporteeId: "raseel",
        hrId: "nesmi",
    }), "raseel");
});

test("leave stays on leave, and attendance requests stay on attendance", () => {
    assert.equal(moduleForRequestType("Employee Leave Request").module, "leave");
    assert.equal(moduleForRequestType("Attendance Leave Request").module, "attendance");
    assert.equal(moduleForRequestType("Attendance Change Request").module, "attendance");
    assert.equal(moduleForRequestType("Hour Approval Request").module, "attendance");
    assert.equal(moduleForRequestType("Flexible OT Request").module, "attendance");
    assert.equal(moduleForRequestType("Attendance Off Day Work").module, "attendance");
});
