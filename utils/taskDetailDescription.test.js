import test from "node:test";
import assert from "node:assert/strict";
import { composeTaskDescription } from "./taskDetailDescription.js";

test("asset description lists the asset, the action, who asked, and why", () => {
    const description = composeTaskDescription({
        requestType: "Asset Assignment",
        extra1: "AST-12 — Drill",
        extra2: "Assignment rejected",
        requestedBy: "Ahmed Khan",
        assetNo: "AST-12",
        assetName: "Drill",
        comment: "Returned with a broken case",
    });
    assert.match(description, /What to do: Complete the asset assignment\./);
    assert.match(description, /Asset No: AST-12/);
    assert.match(description, /Asset Name: Drill/);
    assert.match(description, /Requested by: Ahmed Khan/);
    assert.match(description, /Reason: Returned with a broken case/);
});

test("vehicle service description lists the vehicle, service, stage, and requester", () => {
    const description = composeTaskDescription({
        requestType: "Vehicle Service Request",
        extra1: "Mechanical Work pending with NESMI SHAMSUDEEN — Schedule",
        extra2: "You have Complete Service pending. Current stage: Schedule. Please complete it to continue this Mechanical Work.",
        requestedBy: "NESMI SHAMSUDEEN",
        assetNo: "VEGA-VEH-014",
        assetName: "Toyota Hilux",
        vehicleNo: "Dubai A 12345",
        source: { serviceNo: "VSR-016", serviceType: "Mechanical Work", stage: "Schedule", currentKm: 45210 },
    });
    assert.match(description, /What to do: Complete Mechanical Work\. Current stage: Schedule\./);
    assert.match(description, /Vehicle No: Dubai A 12345/);
    assert.match(description, /Asset No: VEGA-VEH-014/);
    assert.match(description, /Asset Name: Toyota Hilux/);
    assert.match(description, /Service No: VSR-016/);
    assert.match(description, /Service: Mechanical Work/);
    assert.match(description, /Stage: Schedule/);
    assert.match(description, /Current KM: 45210/);
    assert.match(description, /Requested by: NESMI SHAMSUDEEN/);
});

test("expiry description names the document and the employee or company it belongs to", () => {
    const employee = composeTaskDescription({
        requestType: "Employee Document Expiry Reminder",
        extra1: "Expiry follow-up required: Passport (Exp: 12 Oct 2026)",
        extra2: "Ahmed Khan (VITS001)",
        subjectName: "Ahmed Khan",
        subjectEmployeeId: "VITS001",
        requestedBy: "System",
    });
    assert.match(employee, /What to do: Renew Passport\. It expires on 12 Oct 2026\./);
    assert.match(employee, /Employee: Ahmed Khan/);
    assert.match(employee, /Employee ID: VITS001/);
    assert.match(employee, /Document: Passport/);
    assert.match(employee, /Expiry: 12 Oct 2026/);

    const company = composeTaskDescription({
        requestType: "Document Expiry Reminder",
        extra1: "Expiry follow-up required: Trade License (Exp: 01 Jan 2027)",
        extra2: "Vega Technologies (C001)",
        requestedBy: "System",
        source: { companyName: "Vega Technologies", companyId: "C001" },
    });
    assert.match(company, /Company: Vega Technologies/);
    assert.match(company, /Company ID: C001/);
    assert.match(company, /Document: Trade License/);
});

test("fine and utility descriptions include the amount, account, and reason", () => {
    const fine = composeTaskDescription({
        requestType: "Fine",
        extra1: "Other Fines",
        extra2: "AED 200",
        requestedBy: "Ahmed Khan",
        source: {
            fineType: "Other Fines",
            amount: 200,
            employeeName: "NESMI SHAMSUDEEN",
            employeeId: "VITS010",
            reason: "Speed camera",
        },
    });
    assert.match(fine, /Fine Type: Other Fines/);
    assert.match(fine, /Amount: AED 200/);
    assert.match(fine, /Employee: NESMI SHAMSUDEEN/);
    assert.match(fine, /Reason: Speed camera/);

    const utility = composeTaskDescription({
        requestType: "Utility Bill Payment Reminder",
        extra1: "SIM cards - 0522575645 - August 2026",
        requestedBy: "System",
    });
    assert.match(utility, /What to do: Pay the SIM cards bill\./);
    assert.match(utility, /Account No: 0522575645/);
    assert.match(utility, /Bill Month: August 2026/);
});

test("a handwritten task keeps its own description", () => {
    assert.equal(composeTaskDescription({
        requestType: "Workflow Task",
        taskName: "Call the supplier",
        description: "Ask about the delayed delivery.",
        manual: true,
    }), "");
});
