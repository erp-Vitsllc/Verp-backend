import crypto from "crypto";
import nodemailer from "nodemailer";
import Company from "../../models/Company.js";
import User from "../../models/User.js";
import DashboardAction from "../../models/DashboardAction.js";
import { getDepartmentHOD } from "../../utils/getDepartmentHOD.js";
import { resolveEmployeeEmail } from "../../utils/resolveEmployeeEmail.js";
import { isRequestUserDesignatedFlowchartHr } from "../../utils/isDesignatedFlowchartHr.js";
import { calculateCompanyActivationProgress } from "../../utils/companyActivation.js";

const KINDS = new Set(["tradeLicense", "establishmentCard", "document", "ownerDoc", "ejari", "insurance"]);

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

const findCompanyByRouteId = async (id) =>
    Company.findOne({
        $or: [{ _id: id.match(/^[0-9a-fA-F]{24}$/) ? id : null }, { companyId: id }],
    });

const isHrLoggedInUser = async (req) => {
    if (await isRequestUserDesignatedFlowchartHr(req)) return true;
    const role = String(req?.user?.role || "").trim().toLowerCase();
    return role === "hr" || role === "human resource" || role === "human resources";
};

const historyDescription = (base, reason) => {
    const r = (reason || "").trim();
    if (!r) return base;
    return `${base} Reason: ${r}`;
};

const prependRows = (docs, rows) => [...(rows || []), ...(docs || [])];
const escapeRegExp = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const buildExtra1Regex = (label) => {
    const escaped = escapeRegExp(label || "");
    return new RegExp(`^Expiry follow-up required:\\s*${escaped}(?:\\s*\\(Exp:\\s*[^)]+\\))?\\s*$`, "i");
};
const cleanupCompanyExpiryNotificationsByLabels = async ({ companyObjectId, labels = [] }) => {
    if (!companyObjectId) return;
    const normalizedLabels = [...new Set((labels || []).map((x) => String(x || "").trim()).filter(Boolean))];
    if (normalizedLabels.length === 0) return;
    await DashboardAction.deleteMany({
        requestId: companyObjectId,
        requestType: "Document Expiry Reminder",
        status: "Pending",
        $or: normalizedLabels.map((label) => ({ extra1: { $regex: buildExtra1Regex(label) } })),
    });
};

const resolveDocumentIndex = (company, entry) => {
    const arr = company.documents || [];
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

const resolveArrayIndex = (company, field, entry) => {
    const arr = company[field] || [];
    if (entry.arrayItemId) {
        const sid = String(entry.arrayItemId);
        const idx = arr.findIndex((d) => d && d._id && String(d._id) === sid);
        if (idx >= 0) return idx;
    }
    if (typeof entry.arrayIndex === "number" && entry.arrayIndex >= 0 && entry.arrayIndex < arr.length) {
        return entry.arrayIndex;
    }
    return -1;
};

const samePendingTarget = (a, b) => {
    if (a.kind !== b.kind) return false;
    if (a.kind === "tradeLicense" || a.kind === "establishmentCard") return true;
    if (a.kind === "document") {
        if (a.documentItemId && b.documentItemId) return String(a.documentItemId) === String(b.documentItemId);
        return (
            typeof a.documentIndex === "number" &&
            typeof b.documentIndex === "number" &&
            a.documentIndex === b.documentIndex
        );
    }
    if (a.kind === "ownerDoc") {
        return (
            a.ownerIndex === b.ownerIndex &&
            String(a.docKey || "") === String(b.docKey || "")
        );
    }
    if (a.kind === "ejari" || a.kind === "insurance") {
        if (a.arrayItemId && b.arrayItemId) return String(a.arrayItemId) === String(b.arrayItemId);
        return (
            typeof a.arrayIndex === "number" &&
            typeof b.arrayIndex === "number" &&
            a.arrayIndex === b.arrayIndex
        );
    }
    return false;
};

const applyApprovedArchive = (company, entry) => {
    const reason = entry.reason || "";
    const supportKey = (entry.supportingAttachmentKey || "").trim();
    const supportName = (entry.supportingAttachmentName || "").trim();

    const supportingRows = [];
    if (supportKey) {
        supportingRows.push({
            type: "Not renew — supporting material",
            description: supportName || "Supporting attachment",
            issueDate: new Date(),
            startDate: new Date(),
            document: {
                url: supportKey,
                name: supportName || "attachment",
                mimeType: "application/pdf",
            },
        });
    }

    if (entry.kind === "tradeLicense") {
        const historyDoc = {
            type: "Previous Trade License",
            description: historyDescription(`Not Renewed - ${company.tradeLicenseNumber || ""}`, reason),
            issueDate: company.tradeLicenseIssueDate,
            startDate: company.tradeLicenseIssueDate,
            expiryDate: company.tradeLicenseExpiry,
            document: company.tradeLicenseAttachment
                ? { url: company.tradeLicenseAttachment, mimeType: "application/pdf" }
                : null,
        };
        const nextDocs = prependRows(company.documents || [], [historyDoc, ...supportingRows]);
        company.set("documents", nextDocs);
        company.tradeLicenseNumber = null;
        company.tradeLicenseIssueDate = null;
        company.tradeLicenseExpiry = null;
        company.tradeLicenseAttachment = null;
        return;
    }

    if (entry.kind === "establishmentCard") {
        const historyDoc = {
            type: "Previous Establishment Card",
            description: historyDescription(`Not Renewed - ${company.establishmentCardNumber || ""}`, reason),
            issueDate: company.establishmentCardIssueDate,
            startDate: company.establishmentCardIssueDate,
            expiryDate: company.establishmentCardExpiry,
            document: company.establishmentCardAttachment
                ? { url: company.establishmentCardAttachment, mimeType: "application/pdf" }
                : null,
        };
        const nextDocs = prependRows(company.documents || [], [historyDoc, ...supportingRows]);
        company.set("documents", nextDocs);
        company.establishmentCardNumber = null;
        company.establishmentCardExpiry = null;
        company.establishmentCardAttachment = null;
        return;
    }

    if (entry.kind === "document") {
        const idx = resolveDocumentIndex(company, entry);
        const itemToRemove = company.documents?.[idx];
        if (!itemToRemove) throw new Error("DOCUMENT_NOT_FOUND");
        const plain = itemToRemove.toObject ? itemToRemove.toObject() : { ...itemToRemove };
        delete plain._id;
        const historyDoc = {
            type: plain.type ? `Previous ${plain.type}` : "Previous Document",
            description: historyDescription(
                `Not Renewed - ${plain.description || plain.type || ""}`,
                reason
            ),
            context: plain.context || undefined,
            provider: plain.provider || undefined,
            issueDate: plain.issueDate || plain.startDate || null,
            expiryDate: plain.expiryDate || null,
            cost: plain.value != null ? plain.value : plain.cost != null ? plain.cost : null,
            archivedAt: new Date(),
            archiveReason: "Not Renewed",
            document:
                plain.document ||
                (plain.attachment ? { url: plain.attachment, mimeType: "application/pdf", name: plain.fileName } : null),
        };
        const next = [...(company.documents || [])];
        next.splice(idx, 1);
        const oldList = [...(company.oldDocuments || [])];
        oldList.push(historyDoc);
        company.set("oldDocuments", oldList);
        company.set("documents", supportingRows.length ? prependRows(next, supportingRows) : next);
        return;
    }

    if (entry.kind === "ownerDoc") {
        const oi = entry.ownerIndex;
        const docKey = entry.docKey;
        const owners = [...(company.owners || [])];
        const owner = owners[oi];
        if (!owner) throw new Error("OWNER_NOT_FOUND");
        const od = owner[docKey];
        if (!od) throw new Error("OWNER_DOC_NOT_FOUND");
        const ownerName = owner.name || `Owner ${oi + 1}`;
        const docLabel = entry.label || docKey;
        const historyDoc = {
            type: `${ownerName} - ${docLabel}`,
            description: historyDescription(`Not Renewed - ${ownerName} ${docLabel}`, reason),
            issueDate: od.issueDate || od.startDate,
            startDate: od.startDate,
            expiryDate: od.expiryDate,
            value: od.value,
            document: od.attachment ? { url: od.attachment, mimeType: "application/pdf" } : od.document || null,
        };
        const nextDocs = prependRows(company.documents || [], [historyDoc, ...supportingRows]);
        company.set("documents", nextDocs);
        owners[oi] = { ...owners[oi], [docKey]: null };
        company.set("owners", owners);
        return;
    }

    if (entry.kind === "ejari" || entry.kind === "insurance") {
        const field = entry.kind;
        const index = resolveArrayIndex(company, field, entry);
        const itemToRemove = company[field]?.[index];
        if (!itemToRemove) throw new Error("ARRAY_ITEM_NOT_FOUND");
        const plain = itemToRemove.toObject ? itemToRemove.toObject() : { ...itemToRemove };
        delete plain._id;
        const label = entry.label || field;
        const historyDoc = {
            ...plain,
            type: plain.type ? `Previous ${plain.type}` : `Previous ${label}`,
            description: historyDescription(`Not Renewed - ${plain.description || ""}`, reason),
            context: field === "ejari" ? "ejari" : field === "insurance" ? "insurance" : plain.context,
            issueDate: plain.issueDate || plain.startDate,
            startDate: plain.startDate,
            expiryDate: plain.expiryDate,
            value: plain.value,
            document:
                plain.document ||
                (plain.attachment ? { url: plain.attachment, mimeType: "application/pdf" } : null),
            provider: plain.provider,
        };
        const updatedFieldList = [...(company[field] || [])];
        updatedFieldList.splice(index, 1);
        const nextDocs = prependRows(company.documents || [], [historyDoc, ...supportingRows]);
        company.set(field, updatedFieldList);
        company.set("documents", nextDocs);
    }
};

const closeDashboardAction = async (companyMongoId, notRenewRequestId, status, comment, actionedByEmpObjectId) => {
    const rows = await DashboardAction.find({
        requestId: companyMongoId,
        requestType: "Company Document Not Renew",
        status: "Pending",
    }).select("_id extra3");
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

export const submitCompanyNotRenewRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const body = req.body || {};
        const kind = String(body.kind || "").trim();
        if (!KINDS.has(kind)) {
            return res.status(400).json({ message: "Invalid not-renew target type." });
        }
        const reason = String(body.reason || "").trim();
        if (reason.length < 3) {
            return res.status(400).json({ message: "Please provide a reason (at least 3 characters)." });
        }

        const company = await findCompanyByRouteId(id);
        if (!company) return res.status(404).json({ message: "Company not found" });

        const pending = (company.pendingNotRenewRequests || []).filter((p) => p.status === "pending");
        const incoming = {
            kind,
            documentIndex: typeof body.documentIndex === "number" ? body.documentIndex : undefined,
            documentItemId: body.documentItemId,
            arrayIndex: typeof body.arrayIndex === "number" ? body.arrayIndex : undefined,
            arrayItemId: body.arrayItemId,
            ownerIndex: typeof body.ownerIndex === "number" ? body.ownerIndex : undefined,
            docKey: body.docKey,
        };
        if (pending.some((p) => samePendingTarget(p, incoming))) {
            return res.status(400).json({ message: "A pending not-renew request already exists for this document." });
        }

        if (kind === "tradeLicense" && !company.tradeLicenseNumber) {
            return res.status(400).json({ message: "No trade license on file to mark as not renewed." });
        }
        if (kind === "establishmentCard" && !company.establishmentCardNumber) {
            return res.status(400).json({ message: "No establishment card on file to mark as not renewed." });
        }
        if (kind === "document") {
            const idx = resolveDocumentIndex(company, incoming);
            if (idx < 0 || !company.documents?.[idx]) {
                return res.status(400).json({ message: "Document not found." });
            }
        }
        if (kind === "ownerDoc") {
            const oi = body.ownerIndex;
            const dk = body.docKey;
            if (typeof oi !== "number" || !dk || !company.owners?.[oi]?.[dk]) {
                return res.status(400).json({ message: "Owner document not found." });
            }
        }
        if (kind === "ejari" || kind === "insurance") {
            const idx = resolveArrayIndex(company, kind, incoming);
            if (idx < 0 || !company[kind]?.[idx]) {
                return res.status(400).json({ message: "Record not found." });
            }
        }

        const autoApprove = await isHrLoggedInUser(req);
        const requestId = crypto.randomUUID();
        const row = {
            requestId,
            kind,
            label: String(body.label || "").trim(),
            documentIndex: typeof body.documentIndex === "number" ? body.documentIndex : undefined,
            documentItemId: body.documentItemId ? String(body.documentItemId) : "",
            arrayIndex: typeof body.arrayIndex === "number" ? body.arrayIndex : undefined,
            arrayItemId: body.arrayItemId ? String(body.arrayItemId) : "",
            ownerIndex: typeof body.ownerIndex === "number" ? body.ownerIndex : undefined,
            docKey: body.docKey ? String(body.docKey) : "",
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
            try {
                applyApprovedArchive(company, row);
            } catch (e) {
                return res.status(400).json({
                    message: e.message === "DOCUMENT_NOT_FOUND" ? "Document no longer exists." : "Could not apply not-renew.",
                });
            }
            await company.save();
            await cleanupCompanyExpiryNotificationsByLabels({
                companyObjectId: company._id,
                labels: [row.label || row.kind],
            });
            const companyObj = company.toObject ? company.toObject() : company;
            return res.status(201).json({
                message: "Not renew applied and moved to Old Documents.",
                activationProgress: calculateCompanyActivationProgress(companyObj),
            });
        }

        company.pendingNotRenewRequests = [...(company.pendingNotRenewRequests || []), row];
        await company.save();

        const hr = await getDepartmentHOD("hr");
        const hrEmail = pickEmail(hr);
        const baseUrl = (process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/$/, "");
        const companyLink = `${baseUrl}/Company/${encodeURIComponent(company.companyId || company._id)}?tab=others`;

        if (hrEmail) {
            await sendMail({
                to: [hrEmail],
                subject: `Company not-renew approval: ${company.name} (${company.companyId})`,
                html: `<div style="font-family:Arial,sans-serif;line-height:1.6;">
                    <p><strong>Flowchart HR</strong> — a user submitted <strong>Not renew</strong> for company documents.</p>
                    <p><strong>Company:</strong> ${company.name} (${company.companyId})</p>
                    <p><strong>Document:</strong> ${row.label || kind}</p>
                    <p><strong>Reason:</strong> ${reason.replace(/</g, "&lt;")}</p>
                    <p><a href="${companyLink}">Open company profile (Documents)</a> to approve or reject.</p>
                </div>`,
            });
        }

        if (hr?._id) {
            await DashboardAction.create({
                assignedTo: hr._id,
                assignedToEmpId: hr.employeeId,
                requestId: company._id,
                requestType: "Company Document Not Renew",
                status: "Pending",
                subjectEmployeeId: company.companyId,
                subjectName: company.name,
                requestedByName: row.submittedByName || "User",
                extra1: `Not renew pending: ${row.label || kind}`,
                extra2: reason.length > 220 ? `${reason.slice(0, 217)}...` : reason,
                extra3: JSON.stringify({
                    notRenewRequestId: requestId,
                    kind: row.kind,
                    label: row.label || row.kind,
                    ownerIndex: row.ownerIndex,
                    docKey: row.docKey || "",
                }),
            });
        }

        return res.status(201).json({ message: "Request submitted for HR approval.", requestId });
    } catch (error) {
        console.error("submitCompanyNotRenewRequest", error);
        return res.status(500).json({ message: error.message || "Server error" });
    }
};

export const respondCompanyNotRenewRequest = async (req, res) => {
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

        const company = await findCompanyByRouteId(id);
        if (!company) return res.status(404).json({ message: "Company not found" });

        const list = company.pendingNotRenewRequests || [];
        const entry = list.find((r) => r.requestId === requestId && r.status === "pending");
        if (!entry) {
            return res.status(404).json({ message: "Pending request not found." });
        }

        if (action === "reject") {
            const hrComment = String(body.hrComment || "").trim();
            if (hrComment.length < 3) {
                return res.status(400).json({ message: "Please provide a rejection reason (at least 3 characters)." });
            }
            company.pendingNotRenewRequests = list.filter((r) => r.requestId !== requestId);
            await company.save();

            await closeDashboardAction(company._id, requestId, "Rejected", hrComment, req.user.employeeObjectId);

            const submitter = entry.submittedByUserId
                ? await User.findById(entry.submittedByUserId).select("email companyEmail name").lean()
                : null;
            const to = (submitter?.companyEmail || submitter?.email || "").trim();
            if (to) {
                await sendMail({
                    to: [to],
                    subject: `Not renew request rejected — ${company.companyId}`,
                    html: `<div style="font-family:Arial,sans-serif;line-height:1.6;">
                        <p>Your request to mark <strong>${entry.label || entry.kind}</strong> as not renewed for
                        <strong>${company.name}</strong> (${company.companyId}) was <strong>rejected</strong>.</p>
                        <p><strong>HR comment:</strong> ${hrComment.replace(/</g, "&lt;")}</p>
                    </div>`,
                });
            }
            return res.json({ message: "Request rejected." });
        }

        // approve
        try {
            applyApprovedArchive(company, entry);
        } catch (e) {
            console.error(e);
            return res.status(400).json({ message: e.message === "DOCUMENT_NOT_FOUND" ? "Document no longer exists." : "Could not apply not-renew." });
        }

        company.pendingNotRenewRequests = list.filter((r) => r.requestId !== requestId);
        await company.save();
        await cleanupCompanyExpiryNotificationsByLabels({
            companyObjectId: company._id,
            labels: [entry.label || entry.kind],
        });

        await closeDashboardAction(company._id, requestId, "Approved", "", req.user.employeeObjectId);

        const submitter = entry.submittedByUserId
            ? await User.findById(entry.submittedByUserId).select("email companyEmail name").lean()
            : null;
        const to = (submitter?.companyEmail || submitter?.email || "").trim();
        if (to) {
            await sendMail({
                to: [to],
                subject: `Not renew request approved — ${company.companyId}`,
                html: `<div style="font-family:Arial,sans-serif;line-height:1.6;">
                    <p>Your request to mark <strong>${entry.label || entry.kind}</strong> as not renewed for
                    <strong>${company.name}</strong> (${company.companyId}) was <strong>approved</strong>.</p>
                    <p>The document has been archived.</p>
                </div>`,
            });
        }

        const companyObj = company.toObject ? company.toObject() : company;
        return res.json({
            message: "Not renew approved and archived.",
            activationProgress: calculateCompanyActivationProgress(companyObj),
        });
    } catch (error) {
        console.error("respondCompanyNotRenewRequest", error);
        return res.status(500).json({ message: error.message || "Server error" });
    }
};
