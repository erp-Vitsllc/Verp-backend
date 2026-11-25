import assert from "node:assert/strict";
import test from "node:test";
import {
    isModuleBarShare,
    moduleBarShareComment,
    moduleBarShareCopies,
    omitDuplicateModuleBarShares,
    sharesModuleBar,
} from "./moduleBarShare.js";

const original = "64b0000000000000000000a1";
const reassignee = "64b0000000000000000000b2";
const passport = "64b0000000000000000000c3";
const visa = "64b0000000000000000000d4";

test("workflow and system module bells can be shared, general bells cannot", () => {
    assert.equal(sharesModuleBar("Employee Document Expiry Reminder"), true);
    assert.equal(sharesModuleBar("Company Activation"), true);
    assert.equal(sharesModuleBar("Document Expiry Reminder"), true);
    assert.equal(sharesModuleBar("Loan"), true);
    assert.equal(sharesModuleBar("Vehicle Service Request"), true);
    assert.equal(sharesModuleBar("Employee Salary Request"), false);
    assert.equal(sharesModuleBar("Employee Certificate Request"), false);
    assert.equal(sharesModuleBar("Employee Asset Request"), false);
    assert.equal(sharesModuleBar("Task Manager"), false);
    assert.equal(sharesModuleBar(""), false);
});

test("a shared bell is marked and is not a second task row", () => {
    const comment = moduleBarShareComment(visa, original);
    assert.equal(isModuleBarShare({ comment }), true);
    assert.equal(isModuleBarShare({ comment: "Closed: duplicate task" }), false);
    assert.equal(isModuleBarShare({}), false);
});

test("every open notification for the record is copied onto the other person's bar", () => {
    const people = [
        { id: original, empId: "E-1" },
        { id: reassignee, empId: "E-2" },
    ];
    const copies = moduleBarShareCopies([
        {
            _id: visa,
            requestType: "Employee Document Expiry Reminder",
            assignedTo: reassignee,
            extra1: "Expiry follow-up required: Visa",
        },
        {
            _id: passport,
            requestType: "Employee Document Expiry Reminder",
            assignedTo: original,
            extra1: "Expiry follow-up required: Passport",
        },
        {
            _id: "64b0000000000000000000e5",
            requestType: "Employee Salary Request",
            assignedTo: original,
        },
        {
            _id: "64b0000000000000000000f6",
            requestType: "Employee Document Expiry Reminder",
            assignedTo: original,
            comment: moduleBarShareComment(visa, original),
        },
    ], people);

    assert.deepEqual(
        copies.map((copy) => copy.comment),
        [
            moduleBarShareComment(visa, original),
            moduleBarShareComment(passport, reassignee),
        ],
    );
});

test("a shared copy is hidden when that person already has the real notification", () => {
    const real = {
        _id: visa,
        requestType: "Company Activation",
        requestId: "64b0000000000000000000aa",
        extra1: "Activation",
        assignedTo: original,
    };
    const share = {
        ...real,
        _id: "64b0000000000000000000bb",
        assignedTo: reassignee,
        comment: moduleBarShareComment(visa, reassignee),
    };
    const kept = omitDuplicateModuleBarShares([share, real]);
    assert.deepEqual(kept.map((item) => item._id), [visa]);
    assert.deepEqual(omitDuplicateModuleBarShares([share]).map((item) => item._id), [share._id]);
});
