import test from "node:test";
import assert from "node:assert/strict";
import { adminDeletedTaskEmail } from "./adminDeletedTaskEmail.js";

test("admin delete email tells the assignee the task is gone", () => {
    const mail = adminDeletedTaskEmail({
        assigneeName: "Netra Prasad",
        taskName: "Asset Assigning",
        taskNumber: "TSK-26-1346",
        description: "Complete the asset assignment.",
        actorName: "Super User(System)",
    });
    assert.equal(mail.subject, "Task deleted: TSK-26-1346 — Asset Assigning");
    assert.match(mail.html, /Hello Netra Prasad/);
    assert.match(mail.html, /Admin deleted this task\. You no longer need to work on it\./);
    assert.match(mail.html, /Asset Assigning/);
    assert.match(mail.html, /TSK-26-1346/);
    assert.match(mail.html, /Complete the asset assignment\./);
    assert.match(mail.html, /Deleted by:.*Super User\(System\)/);
    assert.doesNotMatch(mail.html, /Open Task/i);
    assert.doesNotMatch(mail.html, /href=/i);
});

test("admin delete email escapes the task name and works without a number", () => {
    const mail = adminDeletedTaskEmail({
        assigneeName: "A & B",
        taskName: "<script>",
        description: "",
        actorName: "",
    });
    assert.equal(mail.subject, "Task deleted: <script>");
    assert.match(mail.html, /Hello A &amp; B/);
    assert.match(mail.html, /&lt;script&gt;/);
    assert.doesNotMatch(mail.html, /<script>/);
    assert.doesNotMatch(mail.html, /Task number/);
    assert.doesNotMatch(mail.html, /Deleted by/);
});
