import test from "node:test";
import assert from "node:assert/strict";
import { chooseKeptDuplicate, documentTaskLabel, duplicateOverlayShouldClose } from "./taskDuplicateKey.js";

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
