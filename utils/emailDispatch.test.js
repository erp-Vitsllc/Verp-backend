import test from "node:test";
import assert from "node:assert/strict";
import {
    documentLabelFromExpiryText,
    emailBelongsToDocumentExpiry,
} from "./emailDispatch.js";

const assetId = "6a4e250d07f3e2578073aa34";

test("expiry text keeps the document name", () => {
    assert.equal(
        documentLabelFromExpiryText("Expiry follow-up required: Mulkia (Registration) (Exp: 16/10/2026)"),
        "Mulkia (Registration)",
    );
    assert.equal(
        documentLabelFromExpiryText("Expiry follow-up required: Mulkia (Registration) [Exp: 16/10/2026]"),
        "Mulkia (Registration)",
    );
});

test("a mulkia expiry task does not list the rest of the vehicle mail", () => {
    const focus = { docLabel: "Mulkia (Registration)", docType: "registration" };
    const mulkia = {
        subject: "[Reminder] Vehicle document expiry 3rd Reminder: Corolla (VEGA-VHCL-001)",
        emailType: "VehicleDocumentExpiry",
        module: "hrm.vehicle.document_expiry",
        recordId: `${assetId}:registration:doc1:3`,
        html: "<p><strong>Document:</strong> Mulkia (Registration)</p>",
    };
    const insurance = {
        subject: "[Reminder] Vehicle document expiry 2nd Reminder: Corolla (VEGA-VHCL-001)",
        emailType: "VehicleDocumentExpiry",
        recordId: `${assetId}:insurance:doc2:2`,
        html: "<p><strong>Document:</strong> Insurance Card</p>",
    };
    const service = {
        subject: "[VeRP] Vehicle service — Mechanical Work pending: VEGA-VHCL-001 — workflow",
        emailType: "workflow",
        recordId: assetId,
        html: "<p>Mechanical Work</p>",
    };
    const assignment = {
        subject: "[Action Required] New Asset Assigned to You: Corolla (VEGA-VHCL-001)",
        emailType: "assignment_pending",
        recordId: assetId,
        html: "<p>A new asset has been assigned.</p>",
    };
    const transfer = {
        subject: "[Information] Asset transferred to MUHAMMED ASHIK: Corolla (VEGA-VHCL-001)",
        emailType: "asset_transfer",
        recordId: assetId,
        html: "<p>An asset has been transferred.</p>",
    };

    assert.equal(emailBelongsToDocumentExpiry(mulkia, focus), true);
    assert.equal(emailBelongsToDocumentExpiry(insurance, focus), false);
    assert.equal(emailBelongsToDocumentExpiry(service, focus), false);
    assert.equal(emailBelongsToDocumentExpiry(assignment, focus), false);
    assert.equal(emailBelongsToDocumentExpiry(transfer, focus), false);
    assert.equal(emailBelongsToDocumentExpiry(insurance, { docLabel: "Insurance Card", docType: "insurance" }), true);
});
