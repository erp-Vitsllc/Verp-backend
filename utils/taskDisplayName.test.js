import test from "node:test";
import assert from "node:assert/strict";
import { formatTaskDisplayParts } from "./taskDisplayName.js";

test("vehicle service lists the service, then the plate", () => {
    const name = formatTaskDisplayParts({
        requestType: "Vehicle Service Request",
        extra1: "Mechanical Work pending with NESMI SHAMSUDEEN — Schedule",
        extra2: "You have Complete Service pending. Current stage: Schedule.",
        extra3: JSON.stringify({ serviceType: "Mechanical Work" }),
        vehicleNo: "Dubai A 12345",
    });
    assert.equal(name.title, "Mechanical Work");
    assert.equal(name.subject, "Dubai A 12345");
});

test("vehicle service lists the vehicle name and the plate under the service", () => {
    const name = formatTaskDisplayParts({
        requestType: "Vehicle Service Request",
        extra1: "Mechanical Work pending with NESMI SHAMSUDEEN — Schedule",
        extra3: JSON.stringify({ serviceType: "Mechanical Work" }),
        assetName: "Toyota Hilux",
        vehicleNo: "Dubai A 12345",
    });
    assert.equal(name.title, "Mechanical Work");
    assert.equal(name.subject, "Toyota Hilux\nDubai A 12345");
});

test("vehicle service still names the service when the plate is missing", () => {
    const name = formatTaskDisplayParts({
        requestType: "Vehicle Service Request",
        extra1: "Oil Service pending with you — Created",
        vehicleNo: "VEGA-VEH-014",
    });
    assert.equal(name.title, "Oil Service");
    assert.equal(name.subject, "VEGA-VEH-014");
});

test("expiry lists the document first, then the owner", () => {
    assert.deepEqual(
        formatTaskDisplayParts({
            requestType: "Employee Document Expiry Reminder",
            extra1: "Expiry follow-up required: Passport (Exp: 12 Oct 2026)",
            extra2: "Ahmed Khan (VITS001)",
            taskName: "Passport Expiry Reminder — Ahmed Khan",
        }),
        { title: "Passport - Expiry", subject: "Ahmed Khan\nVITS001" },
    );
    assert.deepEqual(
        formatTaskDisplayParts({
            requestType: "Vehicle Document Expiry Reminder",
            extra1: "Expiry follow-up required: Insurance (Exp: 01 Nov 2026)",
            extra2: "Toyota Hilux (VEGA-VEH-014)",
            vehicleNo: "Dubai A 12345",
            taskName: "Document Expiry",
        }),
        { title: "Insurance - Expiry", subject: "Toyota Hilux\nDubai A 12345" },
    );
    assert.deepEqual(
        formatTaskDisplayParts({
            requestType: "Vehicle Document Expiry Reminder",
            extra1: "Expiry follow-up required: Insurance (Exp: 01 Nov 2026)",
            extra2: "Toyota Hilux (VEGA-VEH-014)",
        }),
        { title: "Insurance - Expiry", subject: "Toyota Hilux\nVEGA-VEH-014" },
    );
    assert.deepEqual(
        formatTaskDisplayParts({
            requestType: "Document Expiry Reminder",
            extra1: "Expiry follow-up required: Trade License (Exp: 01 Jan 2027)",
            extra2: "Vega Technologies (C001)",
        }),
        { title: "Trade License - Expiry", subject: "Vega Technologies\nC001" },
    );
    assert.deepEqual(
        formatTaskDisplayParts({
            requestType: "Vehicle Document Expiry Reminder",
            extra1: "Expiry follow-up required: Mulkia (Registration) (Exp: 16/10/2026)",
            extra2: "Corolla (VEGA-VHCL-001)",
            taskName: "Corolla (VEGA-VHCL-001)",
        }),
        { title: "Mulkia (Registration) - Expiry", subject: "Corolla\nVEGA-VHCL-001" },
    );
});

test("utility reminder lists the bill type, then the account", () => {
    assert.deepEqual(
        formatTaskDisplayParts({
            requestType: "Utility Bill Payment Reminder",
            extra1: "SIM cards · 0522575645 · August 2026",
        }),
        { title: "SIM cards", subject: "0522575645" },
    );
    assert.deepEqual(
        formatTaskDisplayParts({
            requestType: "Utility Bill Payment Reminder",
            extra1: "Electricity and Water Bills - 2041335012 - August 2026",
        }),
        { title: "Electricity and Water Bills", subject: "2041335012" },
    );
});

test("fine, not-renew, leave, and asset names list the task, then the person or record", () => {
    assert.deepEqual(
        formatTaskDisplayParts({ requestType: "Fine", extra1: "Other Fines" }),
        { title: "Other Fines", subject: "" },
    );
    assert.deepEqual(
        formatTaskDisplayParts({
            requestType: "Employee Document Not Renew",
            extra1: "Not renew pending: Visa",
            extra2: "Employee is travelling",
            subjectName: "Ahmed Khan",
            subjectEmployeeId: "VITS001",
        }),
        { title: "Visa - Not Renew", subject: "Ahmed Khan\nVITS001" },
    );
    assert.deepEqual(
        formatTaskDisplayParts({
            requestType: "Employee Leave Request",
            extra2: "Comp off request for 2026-10-01",
            extra3: JSON.stringify({
                from: "2026-10-01",
                to: "2026-10-03",
                requestedStatusKey: "compoff_leave",
                leaveRequestKind: "leave",
            }),
            subjectName: "Ahmed Khan",
        }),
        { title: "Oct 1, 2026 – Oct 3, 2026 Comp Off", subject: "Ahmed Khan" },
    );
    assert.deepEqual(
        formatTaskDisplayParts({
            requestType: "Attendance Change Request",
            extra1: "Not marked → Late Arrival (09:37 – 18:17) · Waiting for HR",
            extra3: JSON.stringify({
                action: "mark",
                date: "2026-10-16",
                statusKey: "late_arrived",
                statusLabel: "Late Arrival",
                timeIn: "09:37",
                timeOut: "18:17",
            }),
            subjectName: "Philipose K",
            taskName: "Philipose K, Attendance Change",
        }),
        { title: "Oct 16, 2026 Late In", subject: "Philipose K" },
    );
    assert.deepEqual(
        formatTaskDisplayParts({
            requestType: "Attendance Change Request",
            extra3: JSON.stringify({
                action: "mark",
                date: "2026-10-02",
                statusKey: "mispunch",
                statusLabel: "Mispunched",
            }),
            subjectName: "Vishnu Prasad",
        }),
        { title: "Oct 2, 2026 Mispunch", subject: "Vishnu Prasad" },
    );
    assert.deepEqual(
        formatTaskDisplayParts({
            requestType: "Attendance Change Request",
            subjectName: "Philipose K",
            source: {
                attendance: true,
                employeeName: "Philipose K",
                date: "2026-10-16",
                from: "2026-10-16",
                to: "2026-10-16",
                requestKind: "OT",
            },
        }),
        { title: "Oct 16, 2026 OT", subject: "Philipose K" },
    );
    assert.deepEqual(
        formatTaskDisplayParts({
            requestType: "Asset Assignment",
            extra1: "AST-12 — Drill",
            assetLabel: "AST-12 — Drill",
        }),
        { title: "Assignment", subject: "AST-12 — Drill" },
    );
    assert.deepEqual(
        formatTaskDisplayParts({
            requestType: "Asset Assignment",
            hasPlate: true,
            vehicleNo: "Dubai B 99881",
        }),
        { title: "Handover", subject: "Dubai B 99881" },
    );
});

test("a task typed by hand keeps the name that was entered", () => {
    assert.deepEqual(
        formatTaskDisplayParts({
            requestType: "Workflow Task",
            taskName: "Call the supplier",
            manual: true,
        }),
        { title: "Call the supplier", subject: "" },
    );
});
