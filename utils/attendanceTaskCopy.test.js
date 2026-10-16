import test from "node:test";
import assert from "node:assert/strict";
import { factsFromAttendanceRows, factsFromChangeRequest } from "./attendanceTaskCopy.js";

test("a change request keeps the exact attendance kind, times, and duration", () => {
    const late = factsFromChangeRequest({
        action: "mark",
        date: "2026-10-16",
        employeeName: "Philipose K",
        employeeId: "VITS022",
        proposed: {
            statusKey: "late_arrived",
            statusLabel: "Late Arrival",
            timeIn: "09:37",
            timeOut: "18:17",
            reason: "Traffic",
        },
        previous: { statusLabel: "Not marked" },
    });
    assert.equal(late.requestKind, "Late In");
    assert.equal(late.timeIn, "09:37");
    assert.equal(late.timeOut, "18:17");
    assert.equal(late.duration, "8h 40m");
    assert.equal(late.reason, "Traffic");

    const mispunch = factsFromChangeRequest({
        action: "mark",
        date: "2026-10-16",
        proposed: { statusKey: "mispunch", statusLabel: "Mispunched", timeIn: "09:00", timeOut: "" },
    });
    assert.equal(mispunch.requestKind, "Mispunch");
});

test("overtime and hour approval keep the requested date and the hours", () => {
    const ot = factsFromChangeRequest({
        action: "flexible_ot",
        date: "2026-10-16",
        employeeName: "Philipose K",
        proposed: {
            statusLabel: "Apply OT",
            timeIn: "07:34",
            timeOut: "22:18",
            flexibleOtHours: 3,
            flexibleOtApprovedHours: 2,
            confirmNextDay: true,
            targetDate: "2026-10-17",
            reason: "Shutdown work",
        },
    });
    assert.equal(ot.requestKind, "OT");
    assert.equal(ot.otRequestedFor, "2026-10-17");
    assert.equal(ot.otHours, "3 hr");
    assert.equal(ot.otApprovedHours, "2 hr");
    assert.equal(ot.timeIn, "07:34");
    assert.equal(ot.timeOut, "22:18");
    assert.equal(ot.duration, "14h 44m");

    const hour = factsFromChangeRequest({
        action: "hour_adjust",
        date: "2026-10-16",
        proposed: {
            hourAdjustKind: "early_go",
            statusLabel: "Early Go",
            timeIn: "08:00",
            timeOut: "16:00",
            hoursApproved: 1,
            hoursTaken: 1.5,
            reason: "Appointment",
        },
    });
    assert.equal(hour.requestKind, "Hour Approval, Early Out");
    assert.equal(hour.hoursApproved, "1 hr");
    assert.equal(hour.hoursTaken, "1.5 hr");
    assert.equal(hour.duration, "8h");
});

test("leave rows name comp off, sick leave, and the date range", () => {
    const comp = factsFromAttendanceRows([
        {
            employeeName: "Ahmed Khan",
            employeeId: "VITS001",
            date: "2026-10-01",
            leaveRequestKind: "leave",
            requestedStatusKey: "compoff_leave",
            requestedStatusLabel: "Comp Off Leave",
            leaveRequestFromDate: "2026-10-01",
            leaveRequestToDate: "2026-10-03",
            leaveRequestReason: "Family",
            previousStatusLabel: "Upcoming",
        },
        {
            date: "2026-10-03",
            leaveRequestKind: "leave",
            requestedStatusKey: "compoff_leave",
        },
    ], "Employee Leave Request");
    assert.equal(comp.requestKind, "Comp Off");
    assert.equal(comp.from, "2026-10-01");
    assert.equal(comp.to, "2026-10-03");
    assert.equal(comp.duration, "3 days");
    assert.equal(comp.reason, "Family");

    const sick = factsFromAttendanceRows([
        {
            employeeName: "Ahmed Khan",
            date: "2026-10-16",
            leaveRequestKind: "leave",
            requestedStatusKey: "sick_leave",
            leaveRequestTimeIn: "09:00",
            leaveRequestTimeOut: "13:00",
            leaveRequestDayPart: "half",
            leaveRequestSession: "am",
        },
    ], "Employee Leave Request");
    assert.equal(sick.requestKind, "Sick Leave");
    assert.equal(sick.timeIn, "09:00");
    assert.equal(sick.timeOut, "13:00");
    assert.equal(sick.duration, "4h");
});
