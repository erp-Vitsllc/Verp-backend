import nodemailer from "nodemailer";
import { resolveFlowchartHrEmployee } from "./resolveFlowchartHrEmployee.js";
import { getSignedFileUrl } from "./s3Upload.js";
import {
    buildCompanyPathWithFocus,
    buildEmployeePathWithFocus,
} from "./notificationFocusNavigation.js";

/** Company progress-bar sections — changes here go through activation HR queue, not informative email. */
export const COMPANY_ACTIVATION_PROGRESS_KEYS = new Set([
    "basicDetails",
    "tradeLicense",
    "establishmentCard",
    "moa",
    "ownerDetails",
    "ownerPassport",
    "ownerEmiratesId",
]);

/** Core employee activation cards — excluded from informative file-change emails. */
export const EMPLOYEE_ACTIVATION_SECTION_KEYS = new Set([
    "basicDetails",
    "passport",
    "visa",
    "emiratesId",
    "labourCard",
    "workDetails",
]);

const escapeHtml = (value = "") =>
    String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

export const actorDisplayName = (actor = {}) => {
    if (actor?.name) return String(actor.name).trim();
    const full = `${actor?.firstName || ""} ${actor?.lastName || ""}`.trim();
    return full || actor?.employeeId || actor?.username || "System";
};

export function isInformativeCompanySectionKey(sectionKey = "") {
    const key = String(sectionKey || "").trim();
    if (!key) return false;
    return !COMPANY_ACTIVATION_PROGRESS_KEYS.has(key);
}

export function isInformativeEmployeeSectionKey(sectionKey = "") {
    const key = String(sectionKey || "").trim();
    if (!key) return false;
    return !EMPLOYEE_ACTIVATION_SECTION_KEYS.has(key);
}

export function isActiveEmployeeProfile(employeeBasic = {}) {
    return String(employeeBasic?.profileStatus || "").toLowerCase() === "active";
}

const OWNER_DOC_FOCUS_BY_KEY = {
    visitVisa: "ownerVisitVisa",
    employmentVisa: "ownerEmploymentVisa",
    spouseVisa: "ownerSpouseVisa",
    visa: "ownerVisitVisa",
    labourCard: "ownerLabourCard",
    medical: "ownerMedical",
    drivingLicense: "ownerDrivingLicense",
};

const COMPANY_DOC_CONTEXT_TAB = {
    memo: "memo",
    certificate: "certificate",
};

const withFrontendBase = (path = "") => {
    const baseUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const p = String(path || "").trim();
    if (!p) return baseUrl;
    if (p.startsWith("http://") || p.startsWith("https://")) return p;
    return `${baseUrl}${p.startsWith("/") ? p : `/${p}`}`;
};

/** Deep link to a company profile section (non-activation cards). */
export function buildCompanyProfileSectionUrl(companyMongoId, { sectionKey = "", docContext = "", ownerTabIndex = null } = {}) {
    if (!companyMongoId) return withFrontendBase("/Company");

    const key = String(sectionKey || "").trim();
    let path = `/Company/${encodeURIComponent(String(companyMongoId))}`;

    if (key === "ejari") {
        path += "?tab=basic";
        return withFrontendBase(buildCompanyPathWithFocus(path, { focusCard: "ejari" }));
    }
    if (key === "insurance") {
        return withFrontendBase(`${path}?tab=others&docStatusTab=live`);
    }
    if (key === "documents") {
        const ctx = String(docContext || "").toLowerCase();
        const docTab = COMPANY_DOC_CONTEXT_TAB[ctx] || "live";
        return withFrontendBase(`${path}?tab=others&docStatusTab=${encodeURIComponent(docTab)}`);
    }
    if (OWNER_DOC_FOCUS_BY_KEY[key]) {
        path += "?tab=owner";
        const focusCard = OWNER_DOC_FOCUS_BY_KEY[key];
        const ownerTab = Number.isInteger(ownerTabIndex) && ownerTabIndex >= 0 ? ownerTabIndex : null;
        return withFrontendBase(buildCompanyPathWithFocus(path, { focusCard, ownerTab }));
    }

    return withFrontendBase(`${path}?tab=basic`);
}

const EMPLOYEE_SECTION_ROUTES = {
    medicalInsurance: { tab: "basic", focusLabel: "Medical Insurance" },
    drivingLicense: { tab: "basic", focusLabel: "Driving License" },
    documents: { tab: "documents", docStatusTab: "live" },
    emergencyContact: { tab: "personal", subTab: "personal-info" },
    signature: { tab: "basic", focusLabel: "Signature" },
    education: { tab: "personal", subTab: "education" },
    experience: { tab: "personal", subTab: "experience" },
    training: { tab: "training" },
    salary: { tab: "salary" },
};

/** Deep link to an employee profile section. */
export function buildEmployeeProfileSectionUrl(employeeId, sectionKey = "") {
    const eid = encodeURIComponent(String(employeeId || "").trim());
    if (!eid) return withFrontendBase("");

    const route = EMPLOYEE_SECTION_ROUTES[String(sectionKey || "").trim()] || { tab: "basic" };
    let path = `/emp/${eid}?tab=${encodeURIComponent(route.tab)}`;
    if (route.subTab) path += `&subTab=${encodeURIComponent(route.subTab)}`;
    if (route.docStatusTab) path += `&docStatusTab=${encodeURIComponent(route.docStatusTab)}`;
    if (route.focusLabel) {
        return withFrontendBase(buildEmployeePathWithFocus(path, route.focusLabel));
    }
    return withFrontendBase(path);
}

const attachmentFromValue = (value) => {
    if (value == null || value === "") return null;
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed || trimmed.startsWith("data:")) return null;
        return { name: trimmed.split("/").pop() || "Attachment", key: trimmed };
    }
    if (typeof value === "object") {
        const key = value.publicId || value.key || null;
        const url = value.url || value.href || null;
        const name = value.name || value.fileName || (key ? String(key).split("/").pop() : "Attachment");
        if (key) return { name, key: String(key) };
        if (url) return { name, key: url };
    }
    return null;
};

export async function resolveFileLinkEntries(attachments = []) {
    const list = Array.isArray(attachments) ? attachments : [attachments];
    const out = [];
    for (const raw of list) {
        const ref = attachmentFromValue(raw);
        if (!ref?.key) continue;
        const signed = await getSignedFileUrl(ref.key);
        out.push({
            name: ref.name || "File",
            url: signed || ref.key,
        });
    }
    return out;
}

const actionLabel = (action = "modified") => {
    const map = {
        added: "Added",
        edited: "Edited",
        updated: "Edited",
        modified: "Modified",
        deleted: "Deleted",
        renewed: "Renewed",
    };
    return map[String(action || "").toLowerCase()] || "Modified";
};

const renderChangeRowsHtml = (changes = []) =>
    changes
        .map((change) => {
            const section = escapeHtml(change.sectionLabel || change.section || "Section");
            const act = escapeHtml(actionLabel(change.action));
            const sectionUrl = escapeHtml(change.profileUrl || "");
            const files = Array.isArray(change.files) ? change.files : [];
            const filesHtml = files.length
                ? `<ul style="margin:6px 0 0;padding-left:18px;">${files
                      .map(
                          (f) =>
                              `<li style="margin:2px 0;"><a href="${escapeHtml(f.url)}" style="color:#2563eb;">${escapeHtml(f.name || "View file")}</a></li>`,
                      )
                      .join("")}</ul>`
                : `<p style="margin:6px 0 0;font-size:12px;color:#64748b;">No attachment link on record.</p>`;

            return `
                <li style="margin:12px 0;padding:12px;border:1px solid #e2e8f0;border-radius:8px;background:#f8fafc;">
                    <p style="margin:0;"><strong>${act}</strong> — ${section}</p>
                    <p style="margin:6px 0 0;"><a href="${sectionUrl}" style="color:#0f766e;font-weight:600;">Open section in VeRP</a></p>
                    ${filesHtml}
                </li>`;
        })
        .join("");

/**
 * Send informative file-change email to Flowchart HR (not an activation task).
 * @param {{ entityType: 'company'|'employee', entityLabel: string, entityCode: string, profileUrl: string, changes: object[], actor: object }} params
 */
export async function notifyFlowchartHrOfProfileFileChanges({
    entityType = "company",
    entityLabel = "",
    entityCode = "",
    profileUrl = "",
    changes = [],
    actor = {},
}) {
    const rows = (Array.isArray(changes) ? changes : []).filter(
        (c) => c && String(c.sectionLabel || c.section || "").trim(),
    );
    if (!rows.length) return { sent: false, reason: "NO_CHANGES" };

    const hrResolved = await resolveFlowchartHrEmployee();
    if (hrResolved?.error) {
        console.warn("[notifyFlowchartHrOfProfileFileChanges]", hrResolved.message);
        return { sent: false, reason: hrResolved.error };
    }

    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!emailUser || !emailPass) {
        console.warn("[notifyFlowchartHrOfProfileFileChanges] Email credentials not configured.");
        return { sent: false, reason: "EMAIL_NOT_CONFIGURED" };
    }

    const hr = hrResolved.employee;
    const hrEmail = hrResolved.email;
    const hrName = `${hr?.firstName || ""} ${hr?.lastName || ""}`.trim() || "HR";
    const updatedBy = escapeHtml(actorDisplayName(actor));
    const label = escapeHtml(entityLabel || (entityType === "company" ? "Company" : "Employee"));
    const code = escapeHtml(entityCode || "—");
    const baseUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const profileLink = escapeHtml(
        profileUrl && profileUrl.startsWith("http")
            ? profileUrl
            : withFrontendBase(profileUrl || (entityType === "company" ? "/Company" : "")),
    );
    const entityHeading = entityType === "company" ? "Company profile file update" : "Employee profile file update";

    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || "smtp.office365.com",
        port: parseInt(process.env.SMTP_PORT, 10) || 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass },
    });

    const subject = `${entityHeading}: ${entityLabel || entityCode || "VeRP"}`.trim();
    const html = `
        <div style="font-family:Segoe UI,Arial,sans-serif;color:#1e293b;line-height:1.55;max-width:680px;margin:0 auto;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
            <div style="background:#0f766e;color:#fff;padding:18px 22px;">
                <h2 style="margin:0;font-size:18px;">${escapeHtml(entityHeading)}</h2>
            </div>
            <div style="padding:22px;">
                <p>Hello <strong>${escapeHtml(hrName)}</strong>,</p>
                <p>A file was added, edited, renewed, or deleted outside profile activation / progress-bar mandatory sections:</p>
                <ul style="list-style:none;padding:0;margin:16px 0;">${renderChangeRowsHtml(rows)}</ul>
                <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;margin:16px 0;">
                    <p style="margin:0;"><strong>${entityType === "company" ? "Company" : "Employee"}:</strong> ${label}</p>
                    <p style="margin:6px 0 0;"><strong>ID:</strong> ${code}</p>
                    <p style="margin:6px 0 0;"><strong>Updated by:</strong> ${updatedBy} via VeRP</p>
                </div>
                <p style="text-align:center;margin:24px 0;">
                    <a href="${profileLink}" style="background:#0f766e;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold;">View in VeRP</a>
                </p>
                <p style="font-size:12px;color:#64748b;margin:0;">Information only — sent through VeRP. This is not a profile activation submission and no dashboard approval task was created.</p>
            </div>
        </div>
    `;

    await transporter.sendMail({
        fromName: actorDisplayName(actor) || "VeRP Portal",
        to: hrEmail,
        subject,
        html,
    });

    return { sent: true };
};

/** Fire-and-forget wrapper — never blocks API responses on email failures. */
export function scheduleFlowchartHrProfileFileChangeEmail(promiseFactory) {
    Promise.resolve()
        .then(() => promiseFactory())
        .catch((err) => {
            console.warn("[scheduleFlowchartHrProfileFileChangeEmail]", err?.message || err);
        });
}
