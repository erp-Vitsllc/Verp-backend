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

test("vehicle service still names the service when the plate is missing", () => {
    const name = formatTaskDisplayName({
        requestType: "Vehicle Service Request",
        extra1: "Oil Service pending with you — Created",
        vehicleNo: "VEGA-VEH-014",
    });
    assert.equal(name, "VEGA-VEH-014, Oil Service");
});

test("expiry name is the document and the employee, vehicle, or company it belongs to", () => {
    assert.equal(
        formatTaskDisplayName({
            requestType: "Employee Document Expiry Reminder",
            extra1: "Expiry follow-up required: Passport (Exp: 12 Oct 2026)",
            extra2: "Ahmed Khan (VITS001)",
        }),
        "Passport Expiry Reminder — Ahmed Khan",
    );
    assert.equal(
        formatTaskDisplayName({
            requestType: "Vehicle Document Expiry Reminder",
            extra1: "Expiry follow-up required: Insurance (Exp: 01 Nov 2026)",
            extra2: "Toyota Hilux (VEGA-VEH-014)",
        }),
        "Insurance Expiry Reminder — Toyota Hilux",
    );
    assert.equal(
        formatTaskDisplayName({
            requestType: "Document Expiry Reminder",
            extra1: "Expiry follow-up required: Trade License (Exp: 01 Jan 2027)",
            extra2: "Vega Technologies (C001)",
        }),
        "Trade License Expiry Reminder — Vega Technologies",
    );
    assert.equal(
        formatTaskDisplayName({
            requestType: "Vehicle Document Expiry Reminder",
            extra1: "Expiry follow-up required: Mulkia (Registration) (Exp: 16/10/2026)",
            extra2: "Corolla (VEGA-VHCL-001)",
            taskName: "Corolla (VEGA-VHCL-001)",
        }),
        "Mulkia (Registration) Expiry Reminder — Corolla",
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
        }),
        "Visa Not Renew — Ahmed Khan",
    );
    assert.equal(
        formatTaskDisplayName({
            requestType: "Employee Leave Request",
            extra2: "Annual Leave request for 2026-10-01",
            subjectName: "Ahmed Khan",
        }),
        "Annual Leave, Ahmed Khan",
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
