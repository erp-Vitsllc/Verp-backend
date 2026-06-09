import crypto from "crypto";
import nodemailer from "nodemailer";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import EmployeePassport from "../../models/EmployeePassport.js";
import EmployeeVisa from "../../models/EmployeeVisa.js";
import EmployeeEmiratesId from "../../models/EmployeeEmiratesId.js";
import EmployeeLabourCard from "../../models/EmployeeLabourCard.js";
import EmployeeMedicalInsurance from "../../models/EmployeeMedicalInsurance.js";
import EmployeeDrivingLicense from "../../models/EmployeeDrivingLicense.js";
import User from "../../models/User.js";
import DashboardAction from "../../models/DashboardAction.js";
import { getDepartmentHOD } from "../../utils/getDepartmentHOD.js";
import { resolveEmployeeEmail } from "../../utils/resolveEmployeeEmail.js";
import { isRequestUserDesignatedFlowchartHr } from "../../utils/isDesignatedFlowchartHr.js";
import { resolveEmployeeId } from "../../services/employeeService.js";
import { cleanupEmployeeExpiryNotificationsByLabels } from "../../utils/cleanupEmployeeExpiryNotifications.js";
import { isActiveEmployeeProfile } from "../../utils/profileFileChangeHrNotify.js";

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

const REQUEST_KINDS = new Set([
    "manualDocument",
    "passport",
    "visa",
    "emiratesId",
    "labourCard",
    "medicalInsurance",
    "drivingLicense",
]);

const ALLOWED_VISA_TYPES = new Set(["visit", "employment", "spouse"]);
const isHrLoggedInUser = async (req) => {
    if (await isRequestUserDesignatedFlowchartHr(req)) return true;
    const role = String(req?.user?.role || "").trim().toLowerCase();
    return role === "hr" || role === "human resource" || role === "human resources";
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
    if (a.kind !== b.kind) return false;
    if (a.kind === "manualDocument") {
        if (a.documentItemId && b.documentItemId) return String(a.documentItemId) === String(b.documentItemId);
        return (
            typeof a.documentIndex === "number" &&
            typeof b.documentIndex === "number" &&
            a.documentIndex === b.documentIndex
        );
    }
    if (a.kind === "visa") {
        return String(a.visaType || "") === String(b.visaType || "");
    }
    // Passport / Emirates / Labour / Medical / Driving are unique per employee.
    return true;
};

const closeDashboardAction = async (employeeMongoId, notRenewRequestId, status, comment, actionedByEmpObjectId) => {
    const rows = await DashboardAction.find({
        requestId: employeeMongoId,
        requestType: "Employee Document Not Renew",
        status: "Pending",
    }).lean();

    const matchedIds = [];
    for (const row of rows) {
        let meta = {};
        try {
            meta = JSON.parse(row.extra3 || "{}");
        } catch {
            meta = {};
        }
        if (meta.notRenewRequestId !== notRenewRequestId) continue;
        matchedIds.push(row._id);
    }
    if (matchedIds.length === 0) return;
    await DashboardAction.updateMany(
        { _id: { $in: matchedIds } },
        {
            status,
            comment: comment || "",
            actionedDate: new Date(),
            ...(actionedByEmpObjectId ? { actionedBy: actionedByEmpObjectId } : {}),
        }
    );
    if (status !== "Pending") {
        await DashboardAction.deleteMany({ _id: { $in: matchedIds } });
    }
};

const pushSupportAttachment = (employee, entry) => {
    const supportKey = (entry.supportingAttachmentKey || "").trim();
    const supportName = (entry.supportingAttachmentName || "").trim();
    if (!supportKey) return;
    if (!employee.oldDocuments) employee.oldDocuments = [];
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
};

const pushOldDocumentRow = (employee, row) => {
    if (!employee.oldDocuments) employee.oldDocuments = [];
    employee.oldDocuments.push(row);
};

const asPlainDocument = (doc) => {
    if (!doc) return null;
    if (doc.toObject) return doc.toObject();
    return { ...doc };
};

const applyApprovedEmployeeArchive = async (employee, entry) => {
    const reason = entry.reason || "";
    pushSupportAttachment(employee, entry);

    if (entry.kind === "manualDocument") {
        const idx = resolveDocumentIndex(employee, entry);
        if (idx < 0) throw new Error("DOCUMENT_NOT_FOUND");
        const source = employee.documents[idx];
        if (!source) throw new Error("DOCUMENT_NOT_FOUND");
        if (!source.expiryDate) throw new Error("DOCUMENT_NOT_EXPIRING");

        const plain = source.toObject ? source.toObject() : { ...source };
        delete plain._id;
        const docObj = asPlainDocument(plain.document);

        pushOldDocumentRow(employee, {
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
        return { cleanedLabel: String(plain.type || "Employee Document") };
    }

    if (entry.kind === "passport") {
        const passport = await EmployeePassport.findOne({ employeeId: employee.employeeId });
        if (!passport?.number) throw new Error("DOCUMENT_NOT_FOUND");
        pushOldDocumentRow(employee, {
            type: "Previous Passport",
            description: historyDescription(`Not Renewed - ${passport.number || ""}`, reason),
            issueDate: passport.issueDate || passport.lastUpdated || null,
            expiryDate: passport.expiryDate || null,
            archivedAt: new Date(),
            archiveReason: "Not Renewed",
            document: asPlainDocument(passport.document),
        });
        await EmployeePassport.deleteOne({ employeeId: employee.employeeId });
        return { cleanedLabel: "Passport" };
    }

    if (entry.kind === "visa") {
        const visaType = String(entry.visaType || "").trim();
        if (!ALLOWED_VISA_TYPES.has(visaType)) throw new Error("INVALID_VISA_TYPE");
        const visa = await EmployeeVisa.findOne({ employeeId: employee.employeeId });
        const details = visa?.[visaType];
        if (!details?.number) throw new Error("DOCUMENT_NOT_FOUND");
        const visaLabel = `${visaType.charAt(0).toUpperCase() + visaType.slice(1)} Visa`;
        pushOldDocumentRow(employee, {
            type: `Previous ${visaLabel}`,
            description: historyDescription(`Not Renewed - ${details.number || ""}`, reason),
            issueDate: details.issueDate || details.lastUpdated || null,
            expiryDate: details.expiryDate || null,
            archivedAt: new Date(),
            archiveReason: "Not Renewed",
            document: asPlainDocument(details.document),
        });
        await EmployeeVisa.updateOne({ employeeId: employee.employeeId }, { $unset: { [visaType]: "" } });
        return { cleanedLabel: visaLabel };
    }

    if (entry.kind === "emiratesId") {
        const e = await EmployeeEmiratesId.findOne({ employeeId: employee.employeeId });
        const details = e?.emiratesId;
        if (!details?.number) throw new Error("DOCUMENT_NOT_FOUND");
        pushOldDocumentRow(employee, {
            type: "Previous Emirates ID",
            description: historyDescription(`Not Renewed - ${details.number || ""}`, reason),
            issueDate: details.issueDate || details.lastUpdated || null,
            expiryDate: details.expiryDate || null,
            archivedAt: new Date(),
            archiveReason: "Not Renewed",
            document: asPlainDocument(details.document),
        });
        await EmployeeEmiratesId.deleteOne({ employeeId: employee.employeeId });
        return { cleanedLabel: "Emirates ID" };
    }

    if (entry.kind === "labourCard") {
        const l = await EmployeeLabourCard.findOne({ employeeId: employee.employeeId });
        const details = l?.labourCard;
        if (!details?.number) throw new Error("DOCUMENT_NOT_FOUND");
        pushOldDocumentRow(employee, {
            type: "Previous Labour Card",
            description: historyDescription(`Not Renewed - ${details.number || ""}`, reason),
            issueDate: details.issueDate || details.lastUpdated || null,
            expiryDate: details.expiryDate || null,
            archivedAt: new Date(),
            archiveReason: "Not Renewed",
            document: asPlainDocument(details.document),
        });
        await EmployeeLabourCard.deleteOne({ employeeId: employee.employeeId });
        return { cleanedLabel: "Labour Card" };
    }

    if (entry.kind === "medicalInsurance") {
        const m = await EmployeeMedicalInsurance.findOne({ employeeId: employee.employeeId });
        const details = m?.medicalInsurance;
        if (!details?.provider) throw new Error("DOCUMENT_NOT_FOUND");
        pushOldDocumentRow(employee, {
            type: "Previous Medical Insurance",
            description: historyDescription(`Not Renewed - ${details.provider || ""}`, reason),
            issueDate: details.issueDate || details.lastUpdated || null,
            expiryDate: details.expiryDate || null,
            archivedAt: new Date(),
            archiveReason: "Not Renewed",
            document: asPlainDocument(details.document),
        });
        await EmployeeMedicalInsurance.deleteOne({ employeeId: employee.employeeId });
        return { cleanedLabel: "Medical Insurance" };
    }

    if (entry.kind === "drivingLicense") {
        const d = await EmployeeDrivingLicense.findOne({ employeeId: employee.employeeId });
        const details = d?.drivingLicenceDetails;
        if (!details?.number) throw new Error("DOCUMENT_NOT_FOUND");
        pushOldDocumentRow(employee, {
            type: "Previous Driving License",
            description: historyDescription(`Not Renewed - ${details.number || ""}`, reason),
            issueDate: details.issueDate || details.lastUpdated || null,
            expiryDate: details.expiryDate || null,
            archivedAt: new Date(),
            archiveReason: "Not Renewed",
            document: asPlainDocument(details.document),
        });
        await EmployeeDrivingLicense.deleteOne({ employeeId: employee.employeeId });
        return { cleanedLabel: "Driving License" };
    }

    throw new Error("UNSUPPORTED_KIND");
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
        if (!REQUEST_KINDS.has(kind)) {
            return res.status(400).json({ message: "Invalid not-renew target type." });
        }

        const incoming = {
            kind,
            documentIndex: typeof body.documentIndex === "number" ? body.documentIndex : undefined,
            documentItemId: body.documentItemId ? String(body.documentItemId) : "",
            visaType: body.visaType ? String(body.visaType) : "",
        };

        const resolved = await resolveEmployeeId(id);
        if (!resolved) return res.status(404).json({ message: "Employee not found" });

        const employee = await EmployeeBasic.findById(resolved._id);
        if (!employee) return res.status(404).json({ message: "Employee not found" });

        if (!isActiveEmployeeProfile(employee)) {
            return res.status(403).json({ message: "Renew and not-renew are only available on active employee profiles." });
        }

        const pending = (employee.pendingNotRenewRequests || []).filter((p) => p.status === "pending");
        if (pending.some((p) => samePendingTarget(p, incoming))) {
            return res.status(400).json({ message: "A pending not-renew request already exists for this document." });
        }

        let label = String(body.label || "").trim();
        if (kind === "manualDocument") {
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
            incoming.documentIndex = docIdx;
            incoming.documentItemId = targetDoc._id ? String(targetDoc._id) : incoming.documentItemId || "";
            if (!label) label = targetDoc.type || "Document";
        } else if (kind === "passport") {
            const passport = await EmployeePassport.findOne({ employeeId: employee.employeeId }).lean();
            if (!passport?.number) return res.status(400).json({ message: "Passport data not found." });
            if (!label) label = "Passport";
        } else if (kind === "visa") {
            const visaType = String(incoming.visaType || "").trim();
            if (!ALLOWED_VISA_TYPES.has(visaType)) {
                return res.status(400).json({ message: "Invalid visa type for not renew." });
            }
            const visa = await EmployeeVisa.findOne({ employeeId: employee.employeeId }).lean();
            const details = visa?.[visaType];
            if (!details?.number) return res.status(400).json({ message: "Visa data not found." });
            if (!label) label = `${visaType.charAt(0).toUpperCase() + visaType.slice(1)} Visa`;
        } else if (kind === "emiratesId") {
            const e = await EmployeeEmiratesId.findOne({ employeeId: employee.employeeId }).lean();
            if (!e?.emiratesId?.number) return res.status(400).json({ message: "Emirates ID data not found." });
            if (!label) label = "Emirates ID";
        } else if (kind === "labourCard") {
            const l = await EmployeeLabourCard.findOne({ employeeId: employee.employeeId }).lean();
            if (!l?.labourCard?.number) return res.status(400).json({ message: "Labour Card data not found." });
            if (!label) label = "Labour Card";
        } else if (kind === "medicalInsurance") {
            const m = await EmployeeMedicalInsurance.findOne({ employeeId: employee.employeeId }).lean();
            if (!m?.medicalInsurance?.provider) return res.status(400).json({ message: "Medical Insurance data not found." });
            if (!label) label = "Medical Insurance";
        } else if (kind === "drivingLicense") {
            const d = await EmployeeDrivingLicense.findOne({ employeeId: employee.employeeId }).lean();
            if (!d?.drivingLicenceDetails?.number) return res.status(400).json({ message: "Driving License data not found." });
            if (!label) label = "Driving License";
        }

        const autoApprove = await isHrLoggedInUser(req);
        const requestId = crypto.randomUUID();
        const row = {
            requestId,
            kind,
            label,
            documentIndex: incoming.documentIndex,
            documentItemId: incoming.documentItemId || "",
            visaType: incoming.visaType || "",
            reason,
            supportingAttachmentKey: String(body.supportingAttachmentKey || "").trim(),
            supportingAttachmentName: String(body.supportingAttachmentName || "").trim(),
            status: "pending",
            submittedByUserId: req.user._id,
            submittedByName: String(req.user.name || req.user.email || "").trim(),
            submittedByEmployeeId: String(req.user.employeeId || "").trim(),
            submittedAt: new Date(),
        };

        if (autoApprove) {
            let deletedDocLabel = row.label || "Employee Document";
            try {
                const result = await applyApprovedEmployeeArchive(employee, row);
                if (result?.cleanedLabel) deletedDocLabel = result.cleanedLabel;
            } catch (e) {
                const msg =
                    e.message === "DOCUMENT_NOT_FOUND"
                        ? "Document no longer exists."
                        : e.message === "DOCUMENT_NOT_EXPIRING"
                          ? "This document no longer has an expiry date."
                          : e.message === "INVALID_VISA_TYPE"
                            ? "Invalid visa type."
                            : e.message === "UNSUPPORTED_KIND"
                              ? "Unsupported not-renew request type."
                              : "Could not apply not-renew.";
                return res.status(400).json({ message: msg });
            }

            await employee.save();
            await cleanupEmployeeExpiryNotificationsByLabels({
                employeeObjectId: employee._id,
                labels: [deletedDocLabel],
            });
            return res.status(201).json({ message: "Not renew applied and moved to Old Documents." });
        }

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
                extra3: JSON.stringify({
                    notRenewRequestId: requestId,
                    kind: row.kind,
                    visaType: row.visaType || "",
                    label: row.label || "",
                }),
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
            const to = resolveEmployeeEmail(submitter || {}).email || "";
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

        let deletedDocLabel = entry.label || "Employee Document";
        try {
            const result = await applyApprovedEmployeeArchive(employee, entry);
            if (result?.cleanedLabel) deletedDocLabel = result.cleanedLabel;
        } catch (e) {
            console.error(e);
            const msg =
                e.message === "DOCUMENT_NOT_FOUND"
                    ? "Document no longer exists."
                    : e.message === "DOCUMENT_NOT_EXPIRING"
                      ? "This document no longer has an expiry date."
                      : e.message === "INVALID_VISA_TYPE"
                        ? "Invalid visa type."
                        : e.message === "UNSUPPORTED_KIND"
                          ? "Unsupported not-renew request type."
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

        const submitter = entry.submittedByUserId
            ? await User.findById(entry.submittedByUserId).select("email companyEmail name").lean()
            : null;
        const to = resolveEmployeeEmail(submitter || {}).email || "";
        if (to) {
            await sendMail({
                to: [to],
                subject: `Not renew request approved — ${employee.employeeId}`,
                html: `<div style="font-family:Arial,sans-serif;line-height:1.6;">
                    <p>Your request to mark <strong>${entry.label}</strong> as not renewed for
                    <strong>${employee.firstName} ${employee.lastName}</strong> (${employee.employeeId}) was <strong>approved</strong>.</p>
                    <p>The document has been archived in Old Documents.</p>
                </div>`,
            });
        }

        return res.json({ message: "Not renew approved and archived." });
    } catch (error) {
        console.error("respondEmployeeDocumentNotRenewRequest", error);
        return res.status(500).json({ message: error.message || "Server error" });
    }
};
