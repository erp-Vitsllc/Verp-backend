import assert from "node:assert/strict";
import test from "node:test";
import {
    buildAssetListSectionPath,
    buildAttendanceSectionPath,
    buildCompanySectionPath,
    buildEmployeeSectionPath,
    buildHubSectionPath,
    buildUtilitySectionPath,
} from "./taskSectionPath.js";
import { accessPathFor } from "./taskManagerModule.js";

const employeeMongoId = "64b0000000000000000000aa";
const requestId = "64b0000000000000000000bb";

test("attendance change opens the mark row and the change request", () => {
    const path = buildAttendanceSectionPath({
        requestType: "Attendance Change Request",
        requestId,
        subjectEmployeeId: "E-100",
        meta: {
            attendanceChange: true,
            date: "2026-08-12",
            staffType: "site",
            employeeMongoId,
            action: "hour_adjust",
        },
    });
    assert.match(path, /^\/HRM\/Attendance\/mark\?/);
    assert.match(path, /date=2026-08-12/);
    assert.match(path, /staffType=site/);
    assert.match(path, new RegExp(`blinkEmployee=${employeeMongoId}`));
    assert.match(path, new RegExp(`changeRequestId=${requestId}`));
    assert.doesNotMatch(path, /hourAttendanceId=/);
});

test("leave, hour, and OT requests open their own modals", () => {
    const leave = buildAttendanceSectionPath({
        requestType: "Attendance Leave Request",
        requestId,
        meta: { date: "2026-08-01", staffType: "office", employeeMongoId },
    });
    assert.match(leave, /leaveAttendanceId=/);
    const hour = buildAttendanceSectionPath({
        requestType: "Hour Approval Request",
        requestId,
        meta: { extra1: "2026-08-02" },
    });
    assert.match(hour, /hourAttendanceId=/);
    assert.match(hour, /date=2026-08-02/);
    const ot = buildAttendanceSectionPath({
        requestType: "Flexible OT Request",
        requestId,
        meta: { date: "2026-08-03" },
    });
    assert.match(ot, /otAttendanceId=/);
});

test("utility payment opens the review modal and a reminder opens add bill", () => {
    const payment = buildUtilitySectionPath({
        requestType: "Utility Bill Payment",
        requestId: "batch-1",
        meta: { batchId: "batch-1", entryId: "entry-9", billId: "bill-2" },
    });
    assert.equal(payment, "/HRM/Asset/UtilityBills?batchId=batch-1");

    const status = buildUtilitySectionPath({
        requestType: "Utility Entry Status Change",
        requestId,
        meta: { statusChangeId: requestId, entryId: "entry-9" },
    });
    assert.match(status, /statusChangeId=/);
    assert.match(status, /review=1/);

    const reminder = buildUtilitySectionPath({
        requestType: "Utility Bill Payment Reminder",
        meta: { entryId: "entry-9", billMonth: "2026-08" },
    });
    assert.match(reminder, /\/details\/entry-9\?/);
    assert.match(reminder, /addBill=1/);
    assert.match(reminder, /billMonth=2026-08/);
});

test("asset list tasks open the bulk or owner-on-duty modal and highlight the row", () => {
    const bulk = buildAssetListSectionPath({
        requestType: "Asset Assignment",
        requestId,
        meta: { isBulkAssignment: true, bulkAssignmentGroupId: "group-4" },
    });
    assert.match(bulk, /bulkAssignmentGroup=group-4/);
    assert.match(bulk, new RegExp(`focusAsset=${requestId}`));
    const duty = buildAssetListSectionPath({
        requestType: "Asset Owner On Duty",
        requestId,
        meta: {},
    });
    assert.match(duty, /ownerOnDutyReview=/);
});

test("employee and company tasks open the profile section or activation review", () => {
    assert.equal(
        buildEmployeeSectionPath("E-100", "Profile Activation"),
        "/emp/E-100?tab=basic&focusCard=basic-details",
    );
    assert.equal(
        buildEmployeeSectionPath("E-100", "Notice Request"),
        "/emp/E-100?tab=work-details",
    );
    assert.match(
        buildCompanySectionPath("C-1", "Company Activation"),
        /activationReview=1/,
    );
    assert.match(buildCompanySectionPath("C-1", "Company Activation"), /focusCard=basicDetails/);
    const hub = buildHubSectionPath({
        requestType: "Employee Asset Request",
        requestId,
        meta: { hubRequest: true, requesterMongoId: employeeMongoId },
    });
    assert.match(hub, /hubRequestId=/);
    assert.match(hub, /viewEmployee=/);
});

test("accessPathFor keeps the attendance modal, asset section, and company review", () => {
    const attendance = accessPathFor(
        { module: "attendance", path: "/HRM/Attendance" },
        requestId,
        "E-100",
        {
            requestType: "Attendance Leave Request",
            extra1: "2026-09-01",
            extra3: JSON.stringify({
                date: "2026-09-01",
                staffType: "office",
                employeeMongoId,
            }),
        },
    );
    assert.match(attendance, /\/HRM\/Attendance\/mark\?/);
    assert.match(attendance, /leaveAttendanceId=/);
    assert.match(attendance, new RegExp(`blinkEmployee=${employeeMongoId}`));

    const asset = accessPathFor(
        { module: "tools", path: "/HRM/Asset" },
        requestId,
        "",
        { requestType: "Asset Loss Damage", extra1: "Loss and Damage" },
    );
    assert.match(asset, new RegExp(`/HRM/Asset/details/${requestId}`));
    assert.match(asset, /focusCard=pendingAction/);
    assert.match(asset, /authAction=damage/);

    const company = accessPathFor(
        { module: "company", path: "/Company" },
        "company-1",
        "",
        { requestType: "Company Activation", extra1: "[Company profile] Review" },
    );
    assert.match(company, /\/Company\/company-1/);
    assert.match(company, /activationReview=1/);
    assert.match(company, /focusCard=basicDetails/);
});
