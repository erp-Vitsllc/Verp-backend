import DashboardAction from "../models/DashboardAction.js";
import User from "../models/User.js";
import EmployeeBasic from "../models/EmployeeBasic.js";

export const parseNotRenewExtra3 = (extra3) => {
    if (extra3 == null || extra3 === "") return {};
    if (typeof extra3 === "object") return extra3;
    try {
        return JSON.parse(extra3);
    } catch {
        return {};
    }
};

export const samePendingNotRenewTarget = (a, b) => {
    if (!a?.kind || !b?.kind || a.kind !== b.kind) return false;
    if (b.closeAllOfKind === true) return true;
    if (a.kind === "tradeLicense" || a.kind === "establishmentCard") return true;
    if (a.kind === "document") {
        if (a.documentItemId && b.documentItemId) {
            return String(a.documentItemId) === String(b.documentItemId);
        }
        return (
            typeof a.documentIndex === "number" &&
            typeof b.documentIndex === "number" &&
            a.documentIndex === b.documentIndex
        );
    }
    if (a.kind === "ownerDoc") {
        const aOi =
            typeof a.ownerIndex === "number"
                ? a.ownerIndex
                : Number.isFinite(Number(a.ownerIndex))
                  ? Number(a.ownerIndex)
                  : null;
        const bOi =
            typeof b.ownerIndex === "number"
                ? b.ownerIndex
                : Number.isFinite(Number(b.ownerIndex))
                  ? Number(b.ownerIndex)
                  : null;
        return aOi === bOi && String(a.docKey || "") === String(b.docKey || "");
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

export const buildNotRenewTargetFromEntry = (entry) => ({
    kind: entry.kind,
    documentIndex: entry.documentIndex,
    documentItemId: entry.documentItemId ? String(entry.documentItemId) : "",
    arrayIndex: entry.arrayIndex,
    arrayItemId: entry.arrayItemId ? String(entry.arrayItemId) : "",
    ownerIndex: entry.ownerIndex,
    docKey: entry.docKey ? String(entry.docKey) : "",
});

export const resolveSubmitterEmployeeBasic = async (entry) => {
    if (entry?.submittedByUserId) {
        const user = await User.findById(entry.submittedByUserId)
            .select("employeeObjectId employeeId")
            .lean();
        if (user?.employeeObjectId) {
            return EmployeeBasic.findById(user.employeeObjectId)
                .select("_id employeeId firstName lastName companyEmail")
                .lean();
        }
        if (user?.employeeId) {
            return EmployeeBasic.findOne({ employeeId: user.employeeId })
                .select("_id employeeId firstName lastName companyEmail")
                .lean();
        }
    }
    if (entry?.submittedByEmployeeId) {
        return EmployeeBasic.findOne({ employeeId: entry.submittedByEmployeeId })
            .select("_id employeeId firstName lastName companyEmail")
            .lean();
    }
    return null;
};

export const closeCreatorNotRenewFollowUpTasks = async (companyMongoId, targetFilter) => {
    if (!companyMongoId) return;
    const rows = await DashboardAction.find({
        requestId: companyMongoId,
        requestType: "Company Document Not Renew",
        status: "Pending",
    })
        .select("_id extra3")
        .lean();

    const ids = [];
    for (const row of rows) {
        const meta = parseNotRenewExtra3(row.extra3);
        if (meta.role !== "creator_followup") continue;
        if (targetFilter && !samePendingNotRenewTarget(meta, targetFilter)) continue;
        ids.push(row._id);
    }
    if (ids.length) {
        await DashboardAction.deleteMany({ _id: { $in: ids } });
    }
};

export const closeHrNotRenewDashboardAction = async (
    companyMongoId,
    notRenewRequestId,
    status,
    comment,
    actionedByEmpObjectId,
) => {
    const rows = await DashboardAction.find({
        requestId: companyMongoId,
        requestType: "Company Document Not Renew",
        status: "Pending",
    }).select("_id extra3");

    const matchedIds = [];
    for (const row of rows) {
        const meta = parseNotRenewExtra3(row.extra3);
        if (meta.role === "creator_followup") continue;
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
        },
    );
    if (status !== "Pending") {
        await DashboardAction.deleteMany({ _id: { $in: matchedIds } });
    }
};

export const createCreatorNotRenewFollowUpAfterReject = async ({ core, entry, hrComment }) => {
    const assignee = await resolveSubmitterEmployeeBasic(entry);
    if (!assignee?._id) return;

    const targetMeta = buildNotRenewTargetFromEntry(entry);
    await closeCreatorNotRenewFollowUpTasks(core._id, targetMeta);

    const baseUrl = (process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/$/, "");
    const companyLink = `${baseUrl}/Company/${encodeURIComponent(core.companyId || core._id)}`;

    const label = entry.label || entry.kind;
    const commentSnippet =
        String(hrComment || "").trim().length > 220
            ? `${String(hrComment).trim().slice(0, 217)}...`
            : String(hrComment || "").trim();

    await DashboardAction.create({
        assignedTo: assignee._id,
        assignedToEmpId: assignee.employeeId,
        requestId: core._id,
        requestType: "Company Document Not Renew",
        status: "Pending",
        subjectEmployeeId: core.companyId,
        subjectName: core.name,
        requestedByName: "HR",
        extra1: `Not renew rejected: ${label} — renew, edit, delete, or resubmit`,
        extra2: commentSnippet,
        extra3: JSON.stringify({
            role: "creator_followup",
            rejectedRequestId: entry.requestId,
            kind: entry.kind,
            label,
            documentIndex: entry.documentIndex,
            documentItemId: entry.documentItemId || "",
            arrayIndex: entry.arrayIndex,
            arrayItemId: entry.arrayItemId || "",
            ownerIndex: entry.ownerIndex,
            docKey: entry.docKey || "",
            companyLink,
        }),
    });
};

const TRADE_LICENSE_UPDATE_KEYS = new Set([
    "tradeLicenseNumber",
    "tradeLicenseIssueDate",
    "tradeLicenseExpiry",
    "tradeLicenseAttachment",
    "tradeLicenseOwnerName",
]);

const ESTABLISHMENT_UPDATE_KEYS = new Set([
    "establishmentCardNumber",
    "establishmentCardIssueDate",
    "establishmentCardExpiry",
    "establishmentCardAttachment",
]);

export const closeCreatorNotRenewFollowUpsFromCompanyUpdate = async (companyMongoId, updateData) => {
    if (!companyMongoId || !updateData || typeof updateData !== "object") return;

    const targets = [];
    if ([...TRADE_LICENSE_UPDATE_KEYS].some((k) => Object.prototype.hasOwnProperty.call(updateData, k))) {
        targets.push({ kind: "tradeLicense", closeAllOfKind: true });
    }
    if ([...ESTABLISHMENT_UPDATE_KEYS].some((k) => Object.prototype.hasOwnProperty.call(updateData, k))) {
        targets.push({ kind: "establishmentCard", closeAllOfKind: true });
    }
    if (Object.prototype.hasOwnProperty.call(updateData, "documents")) {
        targets.push({ kind: "document", closeAllOfKind: true });
    }
    if (Object.prototype.hasOwnProperty.call(updateData, "owners")) {
        targets.push({ kind: "ownerDoc", closeAllOfKind: true });
    }
    if (Object.prototype.hasOwnProperty.call(updateData, "ejari")) {
        targets.push({ kind: "ejari", closeAllOfKind: true });
    }
    if (Object.prototype.hasOwnProperty.call(updateData, "insurance")) {
        targets.push({ kind: "insurance", closeAllOfKind: true });
    }

    for (const target of targets) {
        await closeCreatorNotRenewFollowUpTasks(companyMongoId, target);
    }
};
