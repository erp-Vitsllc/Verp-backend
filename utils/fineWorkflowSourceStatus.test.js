import test from "node:test";
import assert from "node:assert/strict";
import { fineWorkflowSourceStatus } from "./fineStageAuth.js";

test("management approval does not finish the task while Accounts still has to pay", () => {
    assert.equal(fineWorkflowSourceStatus({
        fineStatus: "Approved",
        accountsPaymentPath: "",
        zohoBillId: "",
        zohoBillNumber: "",
        vendorBillStatus: "Pending",
    }), "Pending");
});

test("a fine waiting on HR stays pending", () => {
    assert.equal(fineWorkflowSourceStatus({
        fineStatus: "Pending HR",
        workflow: [{ role: "HR", status: "Pending" }],
    }), "Pending");
});

test("a fine is finished after the Zoho bill is entered", () => {
    assert.equal(fineWorkflowSourceStatus({
        fineStatus: "Approved",
        zohoBillId: "bill-1",
    }), "Completed");
});

test("a rejected fine stays rejected", () => {
    assert.equal(fineWorkflowSourceStatus({
        fineStatus: "Rejected",
    }), "Rejected");
});
