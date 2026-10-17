import test from "node:test";
import assert from "node:assert/strict";
import { formatTaskDisplayName } from "./taskDisplayName.js";

test("vehicle service name is the vehicle number and the service type", () => {
    const name = formatTaskDisplayName({
        requestType: "Vehicle Service Request",
        extra1: "Mechanical Work pending with NESMI SHAMSUDEEN — Schedule",
        extra2: "You have Complete Service pending. Current stage: Schedule.",
        extra3: JSON.stringify({ serviceType: "Mechanical Work" }),
        vehicleNo: "Dubai A 12345",
    });
    assert.equal(name, "Dubai A 12345, Mechanical Work");
});

test("vehicle service uses the vehicle name when the asset has one", () => {
    const name = formatTaskDisplayName({
        requestType: "Vehicle Service Request",
        extra1: "Mechanical Work pending with NESMI SHAMSUDEEN — Schedule",
        extra3: JSON.stringify({ serviceType: "Mechanical Work" }),
        assetName: "Toyota Hilux",
        vehicleNo: "Dubai A 12345",
    });
    assert.equal(name, "Toyota Hilux, Mechanical Work");
});

test("vehicle service still names the service when the plate is missing", () => {
    const name = formatTaskDisplayName({
        requestType: "Vehicle Service Request",
        extra1: "Oil Service pending with you — Created",
        vehicleNo: "VEGA-VEH-014",
    });
    assert.equal(name, "VEGA-VEH-014, Oil Service");
});

test("expiry name is the number, the document, and expiry or not renew", () => {
    assert.equal(
        formatTaskDisplayName({
            requestType: "Employee Document Expiry Reminder",
            extra1: "Expiry follow-up required: Passport (Exp: 12 Oct 2026)",
            extra2: "Ahmed Khan (VITS001)",
            taskName: "Passport Expiry Reminder — Ahmed Khan",
        }),
        "VITS001 - Passport - Expiry",
    );
    assert.equal(
        formatTaskDisplayName({
            requestType: "Vehicle Document Expiry Reminder",
            extra1: "Expiry follow-up required: Insurance (Exp: 01 Nov 2026)",
            extra2: "Toyota Hilux (VEGA-VEH-014)",
            vehicleNo: "Dubai A 12345",
            taskName: "Document Expiry",
        }),
        "Dubai A 12345 - Insurance - Expiry",
    );
    assert.equal(
        formatTaskDisplayName({
            requestType: "Vehicle Document Expiry Reminder",
            extra1: "Expiry follow-up required: Insurance (Exp: 01 Nov 2026)",
            extra2: "Toyota Hilux (VEGA-VEH-014)",
        }),
        "VEGA-VEH-014 - Insurance - Expiry",
    );
    assert.equal(
        formatTaskDisplayName({
            requestType: "Document Expiry Reminder",
            extra1: "Expiry follow-up required: Trade License (Exp: 01 Jan 2027)",
            extra2: "Vega Technologies (C001)",
        }),
        "C001 - Trade License - Expiry",
    );
    assert.equal(
        formatTaskDisplayName({
            requestType: "Vehicle Document Expiry Reminder",
            extra1: "Expiry follow-up required: Mulkia (Registration) (Exp: 16/10/2026)",
            extra2: "Corolla (VEGA-VHCL-001)",
            taskName: "Corolla (VEGA-VHCL-001)",
        }),
        "VEGA-VHCL-001 - Mulkia (Registration) - Expiry",
    );
});

test("utility reminder name is the bill type and the account, without the month", () => {
    assert.equal(
        formatTaskDisplayName({
            requestType: "Utility Bill Payment Reminder",
            extra1: "SIM cards · 0522575645 · August 2026",
        }),
        "SIM cards, 0522575645",
    );
    assert.equal(
        formatTaskDisplayName({
            requestType: "Utility Bill Payment Reminder",
            extra1: "Electricity and Water Bills - 2041335012 - August 2026",
        }),
        "Electricity and Water Bills, 2041335012",
    );
});

test("fine, not-renew, leave, and asset names stay short", () => {
    assert.equal(
        formatTaskDisplayName({ requestType: "Fine", extra1: "Other Fines" }),
        "Other Fines",
    );
    assert.equal(
        formatTaskDisplayName({
            requestType: "Employee Document Not Renew",
            extra1: "Not renew pending: Visa",
            extra2: "Employee is travelling",
            subjectName: "Ahmed Khan",
            subjectEmployeeId: "VITS001",
        }),
        "VITS001 - Visa - Not Renew",
    );
    assert.equal(
        formatTaskDisplayName({
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
        "Employee - Oct 1, 2026 – Oct 3, 2026 Comp Off",
    );
    assert.equal(
        formatTaskDisplayName({
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
        "Employee - Oct 16, 2026 Late In",
    );
    assert.equal(
        formatTaskDisplayName({
            requestType: "Attendance Change Request",
            extra3: JSON.stringify({
                action: "mark",
                date: "2026-10-02",
                statusKey: "mispunch",
                statusLabel: "Mispunched",
            }),
            subjectName: "Vishnu Prasad",
        }),
        "Employee - Oct 2, 2026 Mispunch",
    );
    assert.equal(
        formatTaskDisplayName({
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
        "Employee - Oct 16, 2026 OT",
    );
    assert.equal(
        formatTaskDisplayName({
            requestType: "Asset Assignment",
            extra1: "AST-12 — Drill",
            assetLabel: "AST-12 — Drill",
        }),
        "AST-12 — Drill, Assignment",
    );
    assert.equal(
        formatTaskDisplayName({
            requestType: "Asset Assignment",
            hasPlate: true,
            vehicleNo: "Dubai B 99881",
        }),
        "Dubai B 99881, Handover",
    );
});

test("a task typed by hand keeps the name that was entered", () => {
    assert.equal(
        formatTaskDisplayName({
            requestType: "Workflow Task",
            taskName: "Call the supplier",
            manual: true,
        }),
        "Call the supplier",
    );
});
