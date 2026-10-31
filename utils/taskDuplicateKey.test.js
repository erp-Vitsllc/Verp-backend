import test from "node:test";
import assert from "node:assert/strict";
import {
    activityTaskKey,
    chooseKeptDuplicate,
    documentTaskLabel,
    duplicateOverlayShouldClose,
    keepActivityCopy,
    pickActivityRow,
} from "./taskDuplicateKey.js";

test("the same expiry document shares one label when only the date differs", () => {
    const fortuner = documentTaskLabel(
        "Expiry follow-up required: Mulkia (Registration) (Exp: 21/10/2026)",
    );
    const sameCard = documentTaskLabel(
        "Expiry follow-up required: Mulkia (Registration) (Exp: 02/10/2026)",
    );
    const insurance = documentTaskLabel(
        "Expiry follow-up required: Insurance Card (Exp: 21/10/2026)",
    );
    assert.equal(fortuner, "mulkia (registration)");
    assert.equal(sameCard, fortuner);
    assert.notEqual(insurance, fortuner);
});

test("a reassigned copy is the one task that stays", () => {
    const older = { _id: "a", requestedDate: "2026-10-14T00:00:00.000Z" };
    const newer = { _id: "b", requestedDate: "2026-10-15T00:00:00.000Z" };
    assert.equal(chooseKeptDuplicate([older, newer])._id, "b");
    assert.equal(
        chooseKeptDuplicate([older, newer], { reassignedIds: new Set(["a"]) })._id,
        "a",
    );
    assert.equal(
        chooseKeptDuplicate([older, newer], { preferId: "a" })._id,
        "a",
    );
});

const fortuner = {
    _id: "fortuner",
    status: "Pending",
    requestId: "asset-fortuner",
    assignedTo: "raseel",
    extra1: "Expiry follow-up required: Mulkia (Registration) (Exp: 15/10/2026)",
    extra2: "Fortuner (VEGA-VHCL-004)",
    day: "2026-10-15",
    hints: ["dubai l 87926", "fortuner"],
};
const corolla = {
    _id: "corolla",
    status: "Pending",
    requestId: "asset-corolla",
    assignedTo: "raseel",
    extra1: "Expiry follow-up required: Mulkia (Registration) (Exp: 16/10/2026)",
    extra2: "Corolla (VEGA-VHCL-002)",
    day: "2026-10-14",
    hints: ["dubai l 87856", "corolla"],
};

test("the task already shown for that request is not closed again", () => {
    assert.equal(duplicateOverlayShouldClose({
        overlay: {
            _id: "kept",
            status: "Pending",
            taskName: "Expiry follow-up required: Mulkia (Registration) (Exp: 21/10/2026)",
            assignee: "raseel",
            day: "2026-10-15",
        },
        source: { requestId: "asset-fortuner", extra1: fortuner.extra1 },
        liveActions: [fortuner, corolla],
        sourceIsLive: true,
        sourceKey: "system|expiry|asset-fortuner|mulkia (registration)",
        liveKeys: new Set(["system|expiry|asset-fortuner|mulkia (registration)"]),
    }), false);
});

test("two documents on one vehicle stay two reminder tasks", () => {
    const mulkia = {
        requestType: "Vehicle Document Expiry Reminder",
        requestId: "vehicle-1",
        extra1: "Expiry follow-up required: Mulkia (Registration) (Exp: 21/10/2026)",
    };
    const insurance = {
        ...mulkia,
        extra1: "Expiry follow-up required: Insurance Card (Exp: 21/10/2026)",
    };
    assert.notEqual(
        activityTaskKey(mulkia, { system: true }),
        activityTaskKey(insurance, { system: true }),
    );
});

test("one fine, loan, or advance keeps every approval on the same task", () => {
    const hr = {
        requestType: "Loan",
        requestId: "loan-1",
        assignedTo: "hr",
        subjectName: "Zeeshan Muhammad",
        extra1: "AED 5000",
        status: "Approved",
    };
    const payment = {
        requestType: "Loan",
        requestId: "loan-1",
        assignedTo: "accounts",
        subjectName: "Zeeshan Muhammad",
        extra1: "Pay to employee — Loan Pending Payment",
        status: "Pending",
    };
    const otherLoan = { ...payment, requestId: "loan-2", extra1: "AED 5000" };
    assert.equal(activityTaskKey(hr), activityTaskKey(payment));
    assert.notEqual(activityTaskKey(payment), activityTaskKey(otherLoan));

    const finePerson = { requestType: "Fine", requestId: "fine-a", fineBaseId: "FN-26-10", status: "Approved" };
    const fineCompany = { requestType: "Group Fine Request", requestId: "fine-b", fineBaseId: "FN-26-10", status: "Pending" };
    const otherFine = { requestType: "Fine", requestId: "fine-c", fineBaseId: "FN-26-11", status: "Pending" };
    assert.equal(activityTaskKey(finePerson), activityTaskKey(fineCompany));
    assert.notEqual(activityTaskKey(fineCompany), activityTaskKey(otherFine));

    const advanceHr = { requestType: "Loan", requestId: "adv-1", extra1: "AED 200", status: "Approved" };
    const advanceAccounts = { requestType: "Loan", requestId: "adv-1", extra1: "AED 200", assignedTo: "accounts", status: "Pending" };
    assert.equal(activityTaskKey(advanceHr), activityTaskKey(advanceAccounts));
});

test("a second service or the admin track is its own task", () => {
    const service = (id, extra3) => ({
        requestType: "Vehicle Service Request",
        requestId: "vehicle-1",
        extra3,
        status: "Pending",
    });
    const hr = service("a", JSON.stringify({ serviceRecordId: "service-a" }));
    const accounts = service("a", JSON.stringify({ serviceRecordId: "service-a" }));
    const otherService = service("b", JSON.stringify({ serviceRecordId: "service-b" }));
    const adminTrack = service("track", JSON.stringify({ serviceRecordId: "service-a", adminOfficerServiceTrack: true }));
    assert.equal(activityTaskKey(hr), activityTaskKey(accounts));
    assert.notEqual(activityTaskKey(hr), activityTaskKey(otherService));
    assert.notEqual(activityTaskKey(hr), activityTaskKey(adminTrack));
});

test("a later approver stays when an older step was reassigned", () => {
    const hr = { _id: "hr", assignedTo: "hr-user", requestedDate: "2026-10-01T00:00:00.000Z" };
    const accounts = { _id: "accounts", assignedTo: "accounts-user", requestedDate: "2026-10-20T00:00:00.000Z" };
    assert.equal(
        keepActivityCopy([hr, accounts], { reassignedIds: new Set(["hr"]) })._id,
        "accounts",
    );
    const olderCopy = { _id: "old", assignedTo: "hr-user", requestedDate: "2026-10-01T00:00:00.000Z" };
    const newerCopy = { _id: "new", assignedTo: "hr-user", requestedDate: "2026-10-20T00:00:00.000Z" };
    assert.equal(
        keepActivityCopy([olderCopy, newerCopy], { reassignedIds: new Set(["old"]) })._id,
        "old",
    );
});

test("the next approval continues the open task, not the hold notice", () => {
    const rows = [
        { _id: "hold", status: "On Hold", updatedAt: 3 },
        { _id: "approved", status: "Approved", updatedAt: 2 },
        { _id: "old", status: "Approved", updatedAt: 1 },
    ];
    assert.equal(pickActivityRow(rows)._id, "approved");
    assert.equal(pickActivityRow([{ _id: "open", status: "Pending" }, ...rows])._id, "open");
    assert.equal(pickActivityRow([{ _id: "paused", status: "On Hold" }])._id, "paused");
});

test("a second expiry row for the same vehicle is closed and the other vehicle stays", () => {
    const ghost = {
        _id: "ghost",
        status: "Pending",
        taskName: "Expiry follow-up required: Mulkia (Registration) (Exp: 21/10/2026)",
        description: "Fortuner (VEGA-VHCL-004)",
        assignee: "raseel",
        day: "2026-10-15",
    };
    assert.equal(duplicateOverlayShouldClose({
        overlay: ghost,
        liveActions: [fortuner, corolla],
    }), true);
    assert.equal(duplicateOverlayShouldClose({
        overlay: { ...ghost, description: "", day: "2026-10-15" },
        liveActions: [fortuner, corolla],
    }), true);
    assert.equal(duplicateOverlayShouldClose({
        overlay: { ...ghost, description: "Corolla (VEGA-VHCL-002)" },
        liveActions: [fortuner],
    }), false);
    assert.equal(duplicateOverlayShouldClose({
        overlay: ghost,
        source: { _id: "fortuner", requestId: "asset-fortuner" },
        liveActions: [fortuner, corolla],
        sourceIsLive: true,
    }), false);
    assert.equal(duplicateOverlayShouldClose({
        overlay: {
            ...ghost,
            description: "",
            taskName: "Expiry follow-up required: Insurance Card (Exp: 21/10/2026)",
        },
        liveActions: [fortuner, corolla],
    }), false);
    assert.equal(duplicateOverlayShouldClose({
        overlay: { ...ghost, description: "", day: "2026-10-15" },
        liveActions: [fortuner, { ...corolla, day: "2026-10-15" }],
    }), false);
    assert.equal(duplicateOverlayShouldClose({
        overlay: { _id: "old-copy", status: "Pending", taskName: "Workflow copy" },
        sourceIsLive: false,
        sourceKey: "system|expiry|asset-fortuner|mulkia (registration)",
        liveKeys: new Set(["system|expiry|asset-fortuner|mulkia (registration)"]),
        liveActions: [fortuner, corolla],
    }), true);
});
