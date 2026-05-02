import crypto from "crypto";
import nodemailer from "nodemailer";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import User from "../../models/User.js";
import DashboardAction from "../../models/DashboardAction.js";
import { getDepartmentHOD } from "../../utils/getDepartmentHOD.js";
import { resolveEmployeeEmail } from "../../utils/resolveEmployeeEmail.js";
import { isRequestUserDesignatedFlowchartHr } from "../../utils/isDesignatedFlowchartHr.js";
import { resolveEmployeeId } from "../../services/employeeService.js";
import { cleanupEmployeeExpiryNotificationsByLabels } from "../../utils/cleanupEmployeeExpiryNotifications.js";

const createTransporter = () => {
    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!emailUser || !emailPass) return null;
    return nodemailer.createTransport({
        host: "smtp.office365.com",
        port: 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass },
    });
};

const sendMail = async ({ to, subject, html }) => {
    const t = createTransporter();
    const emailUser = process.env.EMAIL_USER?.trim();
    if (!t || !to?.length || !emailUser) return;
    await t.sendMail({
        from: `"VeRP Notifications" <${emailUser}>`,
        to: to.join(","),
        subject,
        html,
    });
};

const pickEmail = (emp) => (emp?.companyEmail || "").trim() || resolveEmployeeEmail(emp || {}).email || null;

const historyDescription = (base, reason) => {
    const r = (reason || "").trim();
    if (!r) return base;
    return `${base} Reason: ${r}`;
};

const isBlockedManualType = (type) => {
    const t = String(type || "").toLowerCase().trim();
    return t === "labour card salary" || t.includes("labour card salary");
};

const resolveDocumentIndex = (employee, entry) => {
    const arr = employee.documents || [];
    if (entry.documentItemId) {
        const sid = String(entry.documentItemId);
        const idx = arr.findIndex((d) => d && d._id && String(d._id) === sid);
        if (idx >= 0) return idx;
    }
    if (typeof entry.documentIndex === "number" && entry.documentIndex >= 0 && entry.documentIndex < arr.length) {
        return entry.documentIndex;
    }
    return -1;
};

const samePendingTarget = (a, b) => {
    if (a.kind !== "manualDocument" || b.kind !== "manualDocument") return false;
    if (a.documentItemId && b.documentItemId) return String(a.documentItemId) === String(b.documentItemId);
    return (
        typeof a.documentIndex === "number" &&
        typeof b.documentIndex === "number" &&
        a.documentIndex === b.documentIndex
    );
};

const closeDashboardAction = async (employeeMongoId, notRenewRequestId, status, comment, actionedByEmpObjectId) => {
    const rows = await DashboardAction.find({
        requestId: employeeMongoId,
        requestType: "Employee Document Not Renew",
        status: "Pending",
    }).lean();

    for (const row of rows) {
        let meta = {};
        try {
            meta = JSON.parse(row.extra3 || "{}");
        } catch {
            meta = {};
        }
        if (meta.notRenewRequestId !== notRenewRequestId) continue;
        await DashboardAction.findByIdAndUpdate(row._id, {
            status,
            comment: comment || "",
            actionedDate: new Date(),
            ...(actionedByEmpObjectId ? { actionedBy: actionedByEmpObjectId } : {}),
        });
        break;
    }
};

const applyApprovedManualArchive = (employee, entry) => {
    const idx = resolveDocumentIndex(employee, entry);
    if (idx < 0) throw new Error("DOCUMENT_NOT_FOUND");
    const source = employee.documents[idx];
    if (!source) throw new Error("DOCUMENT_NOT_FOUND");
    if (!source.expiryDate) throw new Error("DOCUMENT_NOT_EXPIRING");

    const reason = entry.reason || "";
    const supportKey = (entry.supportingAttachmentKey || "").trim();
    const supportName = (entry.supportingAttachmentName || "").trim();

    if (!employee.oldDocuments) employee.oldDocuments = [];

    if (supportKey) {
        employee.oldDocuments.push({
            type: "Not renew — supporting material",
            description: supportName || "Supporting attachment",
            issueDate: new Date(),
            expiryDate: null,
            archivedAt: new Date(),
            archiveReason: "Not Renewed",
            document: {
                url: supportKey,
                name: supportName || "attachment",
                mimeType: "application/pdf",
            },
        });
    }

    const plain = source.toObject ? source.toObject() : { ...source };
    delete plain._id;
    const docObj = plain.document?.toObject
        ? plain.document.toObject()
        : plain.document
          ? { ...plain.document }
          : null;

    employee.oldDocuments.push({
        type: plain.type || "",
        description: historyDescription(
            `Not Renewed - ${plain.description || plain.type || "Document"}`,
            reason
        ),
        issueDate: plain.issueDate || null,
        expiryDate: plain.expiryDate || null,
        cost: plain.cost ?? null,
        basicSalary: plain.basicSalary ?? null,
        houseRentAllowance: plain.houseRentAllowance ?? null,
        vehicleAllowance: plain.vehicleAllowance ?? null,
        fuelAllowance: plain.fuelAllowance ?? null,
        otherAllowance: plain.otherAllowance ?? null,
        totalSalary: plain.totalSalary ?? null,
        createdAt: plain.createdAt || null,
        archivedAt: new Date(),
        archiveReason: "Not Renewed",
        document: docObj,
    });

    employee.documents.splice(idx, 1);
};

/** POST /Employee/:id/document-not-renew-requests */
export const submitEmployeeDocumentNotRenewRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const body = req.body || {};

        const reason = String(body.reason || "").trim();
        if (reason.length < 3) {
            return res.status(400).json({ message: "Please provide a reason (at least 3 characters)." });
        }

        const kind = String(body.kind || "manualDocument").trim();
        if (kind !== "manualDocument") {
            return res.status(400).json({ message: "Invalid not-renew target type." });
        }

        const incoming = {
            kind: "manualDocument",
            documentIndex: typeof body.documentIndex === "number" ? body.documentIndex : undefined,
            documentItemId: body.documentItemId ? String(body.documentItemId) : "",
        };

        const resolved = await resolveEmployeeId(id);
        if (!resolved) return res.status(404).json({ message: "Employee not found" });

        const employee = await EmployeeBasic.findById(resolved._id);
        if (!employee) return res.status(404).json({ message: "Employee not found" });

        const pending = (employee.pendingNotRenewRequests || []).filter((p) => p.status === "pending");
        if (pending.some((p) => samePendingTarget(p, incoming))) {
            return res.status(400).json({ message: "A pending not-renew request already exists for this document." });
        }

        const docIdx = resolveDocumentIndex(employee, incoming);
        if (docIdx < 0 || !employee.documents?.[docIdx]) {
            return res.status(400).json({ message: "Document not found." });
        }
        const targetDoc = employee.documents[docIdx];
        if (!targetDoc.expiryDate) {
            return res.status(400).json({ message: "Only expiring manual documents support this workflow." });
        }
        if (isBlockedManualType(targetDoc.type)) {
            return res.status(400).json({ message: "This document type cannot use not-renew workflow." });
        }

        const requestId = crypto.randomUUID();
        const row = {
            requestId,
            kind: "manualDocument",
            label: String(body.label || "").trim() || targetDoc.type || "Document",
            documentIndex: docIdx,
            documentItemId: targetDoc._id ? String(targetDoc._id) : incoming.documentItemId || "",
            reason,
            supportingAttachmentKey: String(body.supportingAttachmentKey || "").trim(),
            supportingAttachmentName: String(body.supportingAttachmentName || "").trim(),
            status: "pending",
            submittedByUserId: req.user._id,
            submittedByName: String(req.user.name || req.user.email || "").trim(),
            submittedByEmployeeId: String(req.user.employeeId || "").trim(),
            submittedAt: new Date(),
        };

        employee.pendingNotRenewRequests = [...(employee.pendingNotRenewRequests || []), row];
        await employee.save();

        const hr = await getDepartmentHOD("hr");
        const hrEmail = pickEmail(hr);
        const baseUrl = (process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/$/, "");
        const slug = encodeURIComponent(employee.employeeId || "");
        const employeeLink = `${baseUrl}/emp/${slug}?tab=documents`;

        if (hrEmail) {
            await sendMail({
                to: [hrEmail],
                subject: `Employee document not-renew approval: ${employee.firstName} ${employee.lastName} (${employee.employeeId})`,
                html: `<div style="font-family:Arial,sans-serif;line-height:1.6;">
                    <p><strong>Flowchart HR</strong> — a user submitted <strong>Not renew</strong> for an employee manual document.</p>
                    <p><strong>Employee:</strong> ${employee.firstName} ${employee.lastName} (${employee.employeeId})</p>
                    <p><strong>Document:</strong> ${row.label}</p>
                    <p><strong>Reason:</strong> ${reason.replace(/</g, "&lt;")}</p>
                    <p><a href="${employeeLink}">Open employee profile (Documents)</a> to approve or reject.</p>
                </div>`,
            });
        }

        if (hr?._id) {
            await DashboardAction.create({
                assignedTo: hr._id,
                assignedToEmpId: hr.employeeId,
                requestId: employee._id,
                requestType: "Employee Document Not Renew",
                status: "Pending",
                subjectEmployeeId: employee.employeeId,
                subjectName: `${employee.firstName} ${employee.lastName}`.trim(),
                requestedByName: row.submittedByName || "User",
                extra1: `Not renew pending: ${row.label}`,
                extra2: reason.length > 220 ? `${reason.slice(0, 217)}...` : reason,
                extra3: JSON.stringify({ notRenewRequestId: requestId }),
            });
        }

        return res.status(201).json({ message: "Request submitted for HR approval.", requestId });
    } catch (error) {
        console.error("submitEmployeeDocumentNotRenewRequest", error);
        return res.status(500).json({ message: error.message || "Server error" });
    }
};

/** POST /Employee/:id/document-not-renew-requests/:requestId/respond */
export const respondEmployeeDocumentNotRenewRequest = async (req, res) => {
    try {
        const { id, requestId } = req.params;
        const body = req.body || {};
        const action = String(body.action || "").toLowerCase();
        if (!["approve", "reject"].includes(action)) {
            return res.status(400).json({ message: "action must be approve or reject." });
        }

        const allowed = await isRequestUserDesignatedFlowchartHr(req);
        if (!allowed) {
            return res.status(403).json({ message: "Only designated Flowchart HR can approve or reject this request." });
        }

        const resolved = await resolveEmployeeId(id);
        if (!resolved) return res.status(404).json({ message: "Employee not found" });

        const employee = await EmployeeBasic.findById(resolved._id);
        if (!employee) return res.status(404).json({ message: "Employee not found" });

        const list = employee.pendingNotRenewRequests || [];
        const entry = list.find((r) => r.requestId === requestId && r.status === "pending");
        if (!entry) {
            return res.status(404).json({ message: "Pending request not found." });
        }

        if (action === "reject") {
            const hrComment = String(body.hrComment || "").trim();
            if (hrComment.length < 3) {
                return res.status(400).json({ message: "Please provide a rejection reason (at least 3 characters)." });
            }
            employee.pendingNotRenewRequests = list.filter((r) => r.requestId !== requestId);
            await employee.save();

            await closeDashboardAction(employee._id, requestId, "Rejected", hrComment, req.user.employeeObjectId);

            const submitter = entry.submittedByUserId
                ? await User.findById(entry.submittedByUserId).select("email companyEmail name").lean()
                : null;
            const to = (submitter?.companyEmail || submitter?.email || "").trim();
            if (to) {
                await sendMail({
                    to: [to],
                    subject: `Not renew request rejected — ${employee.employeeId}`,
                    html: `<div style="font-family:Arial,sans-serif;line-height:1.6;">
                        <p>Your request to mark <strong>${entry.label}</strong> as not renewed for
                        <strong>${employee.firstName} ${employee.lastName}</strong> (${employee.employeeId}) was <strong>rejected</strong>.</p>
                        <p><strong>HR comment:</strong> ${hrComment.replace(/</g, "&lt;")}</p>
                    </div>`,
                });
            }
            return res.json({ message: "Request rejected." });
        }

        const idxCleanup = resolveDocumentIndex(employee, entry);
        let deletedDocLabel = "Employee Document";
        if (idxCleanup >= 0 && employee.documents?.[idxCleanup]) {
            deletedDocLabel = String(employee.documents[idxCleanup].type || deletedDocLabel).trim();
        }

        try {
            applyApprovedManualArchive(employee, entry);
        } catch (e) {
            console.error(e);
            const msg =
                e.message === "DOCUMENT_NOT_FOUND"
                    ? "Document no longer exists."
                    : e.message === "DOCUMENT_NOT_EXPIRING"
                      ? "This document no longer has an expiry date."
                      : "Could not apply not-renew.";
            return res.status(400).json({ message: msg });
        }

        employee.pendingNotRenewRequests = list.filter((r) => r.requestId !== requestId);
        await employee.save();

        await cleanupEmployeeExpiryNotificationsByLabels({
            employeeObjectId: employee._id,
            labels: [deletedDocLabel],
        });

        await closeDashboardAction(employee._id, requestId, "Approved", "", req.user.employeeObjectId);

        return res.json({ message: "Not renew approved and archived." });
    } catch (error) {
        console.error("respondEmployeeDocumentNotRenewRequest", error);
        return res.status(500).json({ message: error.message || "Server error" });
    }
};
