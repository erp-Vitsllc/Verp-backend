import nodemailer from "nodemailer";
import { resolveFlowchartHrEmployee } from "./resolveFlowchartHrEmployee.js";
import {
    buildCompanyPathWithFocus,
    buildEmployeePathWithFocus,
} from "./notificationFocusNavigation.js";
import { resolveFrontendBaseUrl, withFrontendPath, resolveFrontendHostLabel } from "./resolveFrontendBaseUrl.js";
import {
    buildInlineEmailAttachments,
    resolveEmailFileLinksForHtml,
    renderEmailPrimaryButton,
    renderEmailSiteFooter,
} from "./emailAccessibleFiles.js";
import { hasEmployeeProfileEverBeenActivated } from "./employeeProfileStatusLock.js";

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

/** Progress-bar mandatory employee cards — queue on active profile; no informative-only email. */
export const EMPLOYEE_ACTIVATION_SECTION_KEYS = new Set([
    "basicDetails",
    "passport",
    "visa",
    "emiratesId",
    "labourCard",
    "workDetails",
    "signature",
    "emergencyContact",
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

/** HR-activated employee — once active, always treated as active across the app. */
export function isActiveEmployeeProfile(employeeBasic = {}) {
    return hasEmployeeProfileEverBeenActivated(employeeBasic);
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

const COMPANY_DOC_FOCUS_BY_CONTEXT = {
    memo: "documentsMemo",
    certificate: "documentsCertificate",
    document_with_expiry: "documentsWithExpiry",
    document_without_expiry: "documentsWithoutExpiry",
    other_document: "documentsLive",
    insurance: "insurance",
    live: "documentsLive",
};

/** Deep link to a company profile section (non-activation cards). */
export function buildCompanyProfileSectionUrl(
    companyMongoId,
    { sectionKey = "", docContext = "", ownerTabIndex = null, frontendBaseUrl = null } = {},
) {
    const baseOpts = frontendBaseUrl;
    if (!companyMongoId) return withFrontendPath("/Company", baseOpts);

    const key = String(sectionKey || "").trim();
    let path = `/Company/${encodeURIComponent(String(companyMongoId))}`;

    if (key === "ejari") {
        path += "?tab=basic";
        return withFrontendPath(buildCompanyPathWithFocus(path, { focusCard: "ejari" }), baseOpts);
    }
    if (key === "insurance") {
        path = `${path}?tab=others&docStatusTab=live`;
        return withFrontendPath(buildCompanyPathWithFocus(path, { focusCard: "insurance" }), baseOpts);
    }
    if (key === "documents") {
        const ctx = String(docContext || "").toLowerCase();
        const docTab = COMPANY_DOC_CONTEXT_TAB[ctx] || "live";
        const focusCard = COMPANY_DOC_FOCUS_BY_CONTEXT[ctx] || "documentsLive";
        path = `${path}?tab=others&docStatusTab=${encodeURIComponent(docTab)}`;
        return withFrontendPath(buildCompanyPathWithFocus(path, { focusCard }), baseOpts);
    }
    if (OWNER_DOC_FOCUS_BY_KEY[key]) {
        path += "?tab=owner";
        const focusCard = OWNER_DOC_FOCUS_BY_KEY[key];
        const ownerTab = Number.isInteger(ownerTabIndex) && ownerTabIndex >= 0 ? ownerTabIndex : null;
        return withFrontendPath(buildCompanyPathWithFocus(path, { focusCard, ownerTab }), baseOpts);
    }

    return withFrontendPath(`${path}?tab=basic`, baseOpts);
}

const EMPLOYEE_SECTION_ROUTES = {
    basicDetails: { tab: "basic", focusLabel: "Basic Details" },
    passport: { tab: "basic", focusLabel: "Passport" },
    visa: { tab: "basic", focusLabel: "Visa" },
    emiratesId: { tab: "basic", focusLabel: "Emirates ID" },
    labourCard: { tab: "basic", focusLabel: "Labour Card" },
    workDetails: { tab: "work", focusLabel: "Work Details" },
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
export function buildEmployeeProfileSectionUrl(employeeId, sectionKey = "", frontendBaseUrl = null) {
    const eid = encodeURIComponent(String(employeeId || "").trim());
    if (!eid) return withFrontendPath("", frontendBaseUrl);

    const route = EMPLOYEE_SECTION_ROUTES[String(sectionKey || "").trim()] || { tab: "basic" };
    let path = `/emp/${eid}?tab=${encodeURIComponent(route.tab)}`;
    if (route.subTab) path += `&subTab=${encodeURIComponent(route.subTab)}`;
    if (route.docStatusTab) path += `&docStatusTab=${encodeURIComponent(route.docStatusTab)}`;
    if (route.focusLabel) {
        return withFrontendPath(buildEmployeePathWithFocus(path, route.focusLabel), frontendBaseUrl);
    }
    return withFrontendPath(path, frontendBaseUrl);
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
    const refs = [];
    for (const raw of list) {
        const ref = attachmentFromValue(raw);
        if (!ref?.key) continue;
        refs.push({ name: ref.name, storageKey: ref.key });
    }
    return resolveEmailFileLinksForHtml(refs);
}

const actionLabel = (action = "modified") => {
    const map = {
        added: "Added",
        edited: "Edited",
        updated: "Edited",
        modified: "Modified",
        deleted: "Deleted",
        renewed: "Renewed",
        not_renewed: "Not Renewed",
        notrenewed: "Not Renewed",
    };
    return map[String(action || "").toLowerCase()] || "Modified";
};

const renderChangeRowsHtml = (changes = []) =>
    changes
        .map((change) => {
            const section = escapeHtml(change.sectionLabel || change.section || "Section");
            const act = escapeHtml(actionLabel(change.action));
            const queuedNote = change.queuedForActivation
                ? ` <span style="color:#92400e;font-size:12px;">(queued for activation)</span>`
                : "";

            return `<li style="margin:6px 0;">${act} — <strong>${section}</strong>${queuedNote}</li>`;
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
    frontendBaseUrl = null,
    req = null,
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
    const resolvedBase = frontendBaseUrl || resolveFrontendBaseUrl(req);
    const siteHost = escapeHtml(resolveFrontendHostLabel(req || resolvedBase));
    const profileLink = escapeHtml(
        profileUrl && profileUrl.startsWith("http")
            ? profileUrl
            : withFrontendPath(profileUrl || (entityType === "company" ? "/Company" : ""), resolvedBase),
    );
    const entityHeading = entityType === "company" ? "Company profile file update" : "Employee profile file update";
    const fileRefs = rows.flatMap((change) =>
        (Array.isArray(change.files) ? change.files : []).map((f) => ({
            name: f.name,
            storageKey: f.storageKey,
            url: f.storageKey || f.url,
        })),
    );
    const emailAttachments = await buildInlineEmailAttachments(fileRefs);
    const attachmentSummary =
        emailAttachments.length > 0
            ? `<p style="margin:0 0 14px;padding:10px 12px;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;font-size:13px;color:#065f46;"><strong>${emailAttachments.length} file(s) attached</strong> — open directly from this email without signing in to VeRP.</p>`
            : "";

    const hasActivationSectionChange = rows.some(
        (c) => c.sectionKey && EMPLOYEE_ACTIVATION_SECTION_KEYS.has(String(c.sectionKey)),
    );
    const adminNote = actor?.isAdmin || actor?.isAdministrator
        ? `<p style="margin:0 0 12px;padding:10px 12px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;font-size:13px;color:#9a3412;"><strong>Administrator change</strong> — an admin ${hasActivationSectionChange ? "updated a profile card on an active employee." : "modified this profile outside activation / progress-bar mandatory sections."}</p>`
        : "";

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
                ${adminNote}
                ${attachmentSummary}
                <p>${hasActivationSectionChange
                    ? "The following card(s) were updated on an active employee profile:"
                    : "The following card(s) were updated:"}</p>
                <ul style="margin:12px 0;padding-left:20px;font-size:14px;">${renderChangeRowsHtml(rows)}</ul>
                <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;margin:16px 0;">
                    <p style="margin:0;"><strong>${entityType === "company" ? "Company" : "Employee"}:</strong> ${label}</p>
                    <p style="margin:6px 0 0;"><strong>ID:</strong> ${code}</p>
                    <p style="margin:6px 0 0;"><strong>Updated by:</strong> ${updatedBy} via VeRP</p>
                    <p style="margin:6px 0 0;"><strong>VeRP site:</strong> ${siteHost}</p>
                </div>
                <p style="text-align:center;margin:24px 0;">
                    ${renderEmailPrimaryButton(profileLink, "View full profile in VeRP")}
                </p>
                ${renderEmailSiteFooter(siteHost)}
                <p style="font-size:12px;color:#64748b;margin:8px 0 0;">Information only — not a profile activation submission and no dashboard approval task was created.</p>
            </div>
        </div>
    `;

    await transporter.sendMail({
        from: `"${actorDisplayName(actor) || "VeRP Portal"}" <${emailUser}>`,
        to: hrEmail,
        subject,
        html,
        ...(emailAttachments.length ? { attachments: emailAttachments } : {}),
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
