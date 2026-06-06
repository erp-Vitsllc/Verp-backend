import nodemailer from "nodemailer";
import { getChangedOwnerNestedDocKeys } from "./ownerPatchScope.js";
import { isActiveCompanyProfile } from "./companyActivation.js";
import { resolveFlowchartHrEmployee } from "./resolveFlowchartHrEmployee.js";

const INDEPENDENT_OWNER_DOC_KEYS = new Set([
    "visitVisa",
    "employmentVisa",
    "spouseVisa",
    "visa",
    "labourCard",
    "medical",
    "drivingLicense",
]);

const INDEPENDENT_OWNER_LABELS = {
    visitVisa: "Owner Visit Visa",
    employmentVisa: "Owner Employment Visa",
    spouseVisa: "Owner Spouse Visa",
    visa: "Owner Visa",
    labourCard: "Owner Labour Card",
    medical: "Owner Medical Insurance",
    drivingLicense: "Owner Driving License",
};

const isArchivedDocumentRow = (d) => {
    if (!d || typeof d !== "object") return false;
    const desc = String(d?.description || "").toLowerCase();
    if (desc.includes("not renewed")) return true;
    if (d?.archivedAt) return true;
    if (String(d?.archiveReason || "").toLowerCase().includes("not renew")) return true;
    return false;
};

const isMoaDocumentRow = (d) => {
    if (!d || typeof d !== "object") return false;
    const ctx = String(d?.context || "").toLowerCase();
    if (ctx === "moa") return true;
    return String(d?.type || "").toLowerCase().includes("moa");
};

const serializeArrayRows = (rows = [], rowNorm) => {
    try {
        return JSON.stringify((Array.isArray(rows) ? rows : []).map(rowNorm).sort((a, b) => a.id.localeCompare(b.id)));
    } catch {
        return String(Array.isArray(rows) ? rows.length : 0);
    }
};

const normalizeBundleRow = (row) => ({
    id: row?._id != null ? String(row._id) : "",
    type: String(row?.type || ""),
    description: String(row?.description || ""),
    issueDate: row?.issueDate ? new Date(row.issueDate).toISOString() : "",
    expiryDate: row?.expiryDate ? new Date(row.expiryDate).toISOString() : "",
    url: String(row?.document?.url || row?.attachment || "").split("?")[0],
});

const normalizeLiveDocumentRow = (row) => ({
    id: row?._id != null ? String(row._id) : "",
    context: String(row?.context || ""),
    type: String(row?.type || ""),
    description: String(row?.description || ""),
    issueDate: row?.issueDate ? new Date(row.issueDate).toISOString() : "",
    expiryDate: row?.expiryDate ? new Date(row.expiryDate).toISOString() : "",
    url: String(row?.document?.url || row?.attachment || "").split("?")[0],
});

const liveNonMoaDocuments = (documents = []) =>
    (Array.isArray(documents) ? documents : []).filter((d) => !isArchivedDocumentRow(d) && !isMoaDocumentRow(d));

const documentRowInformLabel = (row) => {
    const ctx = String(row?.context || "").toLowerCase();
    if (ctx === "memo") return "Memo";
    if (ctx === "certificate") return "Certificate";
    if (ctx === "document_with_expiry") return "Document With Expiry";
    if (ctx === "document_without_expiry") return "Document Without Expiry";
    if (ctx === "insurance") return "Insurance";
    if (ctx === "other_document") return "Document";
    const type = String(row?.type || "").trim();
    return type || "Document";
};

const actorDisplayName = (actor = {}) => {
    if (actor?.name) return String(actor.name).trim();
    const full = `${actor?.firstName || ""} ${actor?.lastName || ""}`.trim();
    return full || actor?.employeeId || "System";
};

/**
 * Cards that apply immediately on active companies — HR gets email only (no queue / dashboard task).
 */
export function collectCompanyInformativeHrNotifyLabels(beforeCompany = {}, updateData = {}) {
    if (!updateData || typeof updateData !== "object") return [];
    const labels = [];

    if (Object.prototype.hasOwnProperty.call(updateData, "ejari")) {
        const beforeSlice = serializeArrayRows(beforeCompany?.ejari, normalizeBundleRow);
        const afterSlice = serializeArrayRows(updateData.ejari, normalizeBundleRow);
        if (beforeSlice !== afterSlice) labels.push("Ejari");
    }

    if (Object.prototype.hasOwnProperty.call(updateData, "insurance")) {
        const beforeSlice = serializeArrayRows(beforeCompany?.insurance, normalizeBundleRow);
        const afterSlice = serializeArrayRows(updateData.insurance, normalizeBundleRow);
        if (beforeSlice !== afterSlice) labels.push("Insurance");
    }

    if (Object.prototype.hasOwnProperty.call(updateData, "documents")) {
        const beforeSlice = serializeArrayRows(
            liveNonMoaDocuments(beforeCompany?.documents),
            normalizeLiveDocumentRow,
        );
        const afterSlice = serializeArrayRows(
            liveNonMoaDocuments(updateData.documents),
            normalizeLiveDocumentRow,
        );
        if (beforeSlice !== afterSlice) {
            for (const row of liveNonMoaDocuments(updateData.documents)) {
                labels.push(documentRowInformLabel(row));
            }
        }
    }

    if (Object.prototype.hasOwnProperty.call(updateData, "owners")) {
        const beforeOwners = beforeCompany?.owners || [];
        const changedKeys = getChangedOwnerNestedDocKeys(updateData.owners, beforeOwners);
        for (const key of changedKeys) {
            if (INDEPENDENT_OWNER_DOC_KEYS.has(key) && INDEPENDENT_OWNER_LABELS[key]) {
                labels.push(INDEPENDENT_OWNER_LABELS[key]);
            }
        }
    }

    return [...new Set(labels.map((x) => String(x || "").trim()).filter(Boolean))];
}

/**
 * Informational email to Flowchart HR — not a dashboard task and not an activation submission.
 */
export async function notifyHrOfCompanyInformativeCardUpdates({
    company = {},
    changedCards = [],
    actor = {},
}) {
    const cards = (Array.isArray(changedCards) ? changedCards : [])
        .map((c) => String(c || "").trim())
        .filter(Boolean);
    if (!cards.length || !isActiveCompanyProfile(company)) return { sent: false };

    const hrResolved = await resolveFlowchartHrEmployee();
    if (hrResolved?.error) {
        console.warn("[notifyHrOfCompanyInformativeCardUpdates]", hrResolved.message);
        return { sent: false, reason: hrResolved.error };
    }

    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!emailUser || !emailPass) {
        console.warn("[notifyHrOfCompanyInformativeCardUpdates] Email credentials not configured.");
        return { sent: false, reason: "EMAIL_NOT_CONFIGURED" };
    }

    const hr = hrResolved.employee;
    const hrEmail = hrResolved.email;
    const hrName = `${hr?.firstName || ""} ${hr?.lastName || ""}`.trim() || "HR";
    const updatedBy = actorDisplayName(actor);
    const companyName = company?.name || "Company";
    const companyCode = company?.companyId || "";
    const baseUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const companyUrl = company?._id ? `${baseUrl}/Company/${company._id}` : `${baseUrl}/Company`;
    const cardsHtml = cards.map((c) => `<li style="margin:4px 0;">${c}</li>`).join("");

    const transporter = nodemailer.createTransport({
        host: "smtp.office365.com",
        port: 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass },
    });

    const subject = `Company profile updated: ${companyName}`;
    const html = `
        <div style="font-family:Segoe UI,Arial,sans-serif;color:#1e293b;line-height:1.55;max-width:640px;margin:0 auto;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
            <div style="background:#0f766e;color:#fff;padding:18px 22px;">
                <h2 style="margin:0;font-size:18px;">Company profile updated (information only)</h2>
            </div>
            <div style="padding:22px;">
                <p>Hello <strong>${hrName}</strong>,</p>
                <p>The following section(s) were saved immediately and do <strong>not</strong> require HR submission approval:</p>
                <ul style="padding-left:20px;margin:12px 0;">${cardsHtml}</ul>
                <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;margin:16px 0;">
                    <p style="margin:0;"><strong>Company:</strong> ${companyName}</p>
                    <p style="margin:6px 0 0;"><strong>Company ID:</strong> ${companyCode || "—"}</p>
                    <p style="margin:6px 0 0;"><strong>Updated by:</strong> ${updatedBy}</p>
                </div>
                <p style="text-align:center;margin:24px 0;">
                    <a href="${companyUrl}" style="background:#0f766e;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold;">View company profile</a>
                </p>
                <p style="font-size:12px;color:#64748b;margin:0;">This is an informational notice only — no action item was created in VeRP.</p>
            </div>
        </div>
    `;

    await transporter.sendMail({
        from: `"VeRP Portal" <${emailUser}>`,
        to: hrEmail,
        subject,
        html,
    });

    return { sent: true };
}
