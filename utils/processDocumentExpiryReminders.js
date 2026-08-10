import nodemailer from "nodemailer";
import Company from "../models/Company.js";
import {
    loadCompaniesForExpiryScan,
    loadCompaniesForExpiryScanByIds,
} from "../services/companyPartitionService.js";
import {
    collectCompanyExpiryDocuments,
    buildEmployeeManualDocumentExpiryLabel,
    isArchivedOrStaleCompanyExpiryRow,
    COMPANY_OWNER_EXPIRY_FIELDS,
    resolveCompanyCertificateExpiryNavigationMeta,
} from "./companyExpiryScanUtils.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import EmployeePassport from "../models/EmployeePassport.js";
import EmployeeVisa from "../models/EmployeeVisa.js";
import EmployeeEmiratesId from "../models/EmployeeEmiratesId.js";
import EmployeeLabourCard from "../models/EmployeeLabourCard.js";
import EmployeeMedicalInsurance from "../models/EmployeeMedicalInsurance.js";
import EmployeeDrivingLicense from "../models/EmployeeDrivingLicense.js";
import DashboardAction from "../models/DashboardAction.js";
import ExpiryReminderLog from "../models/ExpiryReminderLog.js";
import User from "../models/User.js";
import { getDepartmentHOD } from "./getDepartmentHOD.js";
import { resolveEmployeeEmail } from "./resolveEmployeeEmail.js";
import { isEmployeeActiveForNotifications, isLeftUserStatus } from "./applyEmployeeLeftUserStatus.js";
import {
    getDaysUntil,
    getEmailReminderStageMarker,
    isExpiryTaskWindow,
    isExpiryHrTaskDueForDoc,
} from "./documentExpiryReminderStages.js";
import AssetItem from "../models/AssetItem.js";
import {
    collectVehicleExpiryDocuments,
    isFleetVehicleAsset,
    resolveVehicleExpiryFocusCard,
    resolveVehicleExpiryTab,
} from "./vehicleExpiryScanUtils.js";
import {
    buildCompanyExpiryEmailLocation,
    buildEmployeeExpiryEmailLocation,
    buildVehicleExpiryEmailLocation,
    escapeExpiryEmailHtml,
    renderExpiryEmailLocationBlock,
} from "./documentExpiryEmailLocation.js";

const STAGE_1_MARKER = 30;
const STAGE_2_MARKER = 20;
const STAGE_3_MARKER = 10;
const STAGE_0_MARKER = 0;

const getReminderStageLabel = (marker) => {
    if (marker === STAGE_1_MARKER) return "1st Reminder";
    if (marker === STAGE_2_MARKER) return "2nd Reminder";
    if (marker === STAGE_3_MARKER) return "3rd Reminder";
    if (marker === STAGE_0_MARKER) return "Expiry Day Reminder";
    return "Reminder";
};

export const formatExpiryDateLabel = (expiryDate) => {
    if (!expiryDate) return "";
    try {
        const d = new Date(expiryDate);
        if (Number.isNaN(d.getTime())) return "";
        return d.toLocaleDateString("en-GB");
    } catch {
        return "";
    }
};

const dedupeEmails = (emails = []) => {
    const seen = new Set();
    return emails
        .map((x) => (x || "").trim())
        .filter(Boolean)
        .filter((e) => {
            const k = e.toLowerCase();
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });
};

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

const sendExpiryReminderEmail = async ({ to, subject, html }) => {
    const transporter = createTransporter();
    if (!transporter || !to?.length) return;
    const emailUser = process.env.EMAIL_USER?.trim();
    await transporter.sendMail({
        from: `"VeRP Notifications" <${emailUser}>`,
        to: to.join(","),
        subject,
        html,
    });
};

/** Remove wrongly assigned expiry follow-ups (tasks belong to Flowchart HR only). */
const purgeNonHrExpiryTasks = async ({ requestId, requestType, hrObjectId }) => {
    if (!requestId || !hrObjectId) return;
    await DashboardAction.deleteMany({
        requestId,
        requestType,
        status: "Pending",
        assignedTo: { $ne: hrObjectId },
        extra1: { $regex: /^Expiry follow-up required:/i },
    });
};

/** Company / employee document expiry tasks — assignee is Flowchart HR only. */
const ensureDashboardAction = async ({
    assignedTo,
    assignedToEmpId,
    requestId,
    subjectEmployeeId,
    subjectName,
    extra1,
    extra2,
    extra3,
    requestType = "Document Expiry Reminder",
}) => {
    if (!assignedTo || !requestId) return;
    const exists = await DashboardAction.findOne({
        assignedTo,
        requestId,
        requestType,
        status: "Pending",
        extra1,
    })
        .select("_id extra3")
        .lean();
    if (exists) {
        if (extra3 && (!exists.extra3 || String(exists.extra3) !== String(extra3))) {
            await DashboardAction.updateOne({ _id: exists._id }, { $set: { extra3 } });
        }
        return;
    }

    await DashboardAction.create({
        assignedTo,
        ...(assignedToEmpId ? { assignedToEmpId } : {}),
        requestId,
        requestType,
        status: "Pending",
        subjectEmployeeId,
        subjectName,
        requestedByName: "System",
        extra1,
        extra2,
        ...(extra3 ? { extra3 } : {}),
    });
};

const removeObsoleteExpiryActions = async ({ requestId, requestType, allowedExtra1Set }) => {
    if (!requestId || !requestType) return;
    const pending = await DashboardAction.find({
        requestId,
        requestType,
        status: "Pending",
    })
        .select("_id extra1")
        .lean();

    const actionIdsToDelete = pending
        .filter((row) => {
            const extra1 = (row?.extra1 || "").trim();
            if (!extra1.toLowerCase().startsWith("expiry follow-up required:")) return false;
            return !allowedExtra1Set.has(extra1);
        })
        .map((row) => row._id);

    if (actionIdsToDelete.length > 0) {
        await DashboardAction.deleteMany({ _id: { $in: actionIdsToDelete } });
    }
};

const wasReminderSent = async ({ targetType, targetId, docKey, daysBefore }) => {
    const x = await ExpiryReminderLog.findOne({ targetType, targetId, docKey, daysBefore }).lean();
    return !!x;
};

const markReminderSent = async ({ targetType, targetId, docKey, daysBefore, expiryDate, metadata }) => {
    await ExpiryReminderLog.updateOne(
        { targetType, targetId, docKey, daysBefore },
        {
            $setOnInsert: {
                targetType,
                targetId,
                docKey,
                daysBefore,
                expiryDate,
                metadata: metadata || {},
                sentAt: new Date(),
            },
        },
        { upsert: true }
    );
};

const pickCompanyAddress = (emp = {}) => {
    if (!isEmployeeActiveForNotifications(emp)) return null;
    return (emp?.companyEmail || "").trim() ||
        resolveEmployeeEmail(emp || {}).email ||
        null;
};

const getFlowchartRecipientBundle = async () => {
    const [admin, hr] = await Promise.all([
        getDepartmentHOD("admincontroller"),
        getDepartmentHOD("hr"),
    ]);
    /** Company document expiry emails: Admin Officer + HR (Flowchart) only. */
    const emails = dedupeEmails([
        pickCompanyAddress(admin || {}),
        pickCompanyAddress(hr || {}),
    ]);
    return { admin, hr, emails };
};

/** Employee document expiry routing: Admin + HR + employee HOD (primary reportee). */
let employeeStaticRecipientsCache = null;
const getEmployeeStaticRecipientBundle = async () => {
    if (employeeStaticRecipientsCache) return employeeStaticRecipientsCache;

    const [adminFlowchart, hr] = await Promise.all([
        getDepartmentHOD("admincontroller"),
        getDepartmentHOD("hr"),
    ]);

    const adminUsers = await User.find({
        isAdmin: true,
        status: "Active",
        employeeId: { $exists: true, $nin: ["", null] },
    })
        .select("employeeId")
        .lean();

    const adminEmployeeIds = [...new Set(adminUsers.map((u) => String(u.employeeId || "").trim()).filter(Boolean))];
    const adminEmployees = adminEmployeeIds.length
        ? await EmployeeBasic.find({
            employeeId: { $in: adminEmployeeIds },
            profileStatus: "active",
            status: { $ne: "Left User" },
        })
            .select("employeeId firstName lastName companyEmail workEmail personalEmail email status profileStatus")
            .lean()
        : [];

    const recipientsByEmployeeId = new Map();
    const pushRecipient = (person) => {
        const key = String(person?.employeeId || "").trim();
        if (!key) return;
        if (!recipientsByEmployeeId.has(key)) recipientsByEmployeeId.set(key, person);
    };

    (adminEmployees || []).forEach(pushRecipient);
    pushRecipient(adminFlowchart);

    employeeStaticRecipientsCache = {
        admins: [...recipientsByEmployeeId.values()],
        hr: hr || null,
    };
    return employeeStaticRecipientsCache;
};

const getEmployeeRecipientBundle = async (employee) => {
    const staticRecipients = await getEmployeeStaticRecipientBundle();
    const [hod] = await Promise.all([
        employee?.primaryReportee
            ? EmployeeBasic.findById(employee.primaryReportee)
                .select("employeeId firstName lastName companyEmail workEmail personalEmail email status profileStatus")
                .lean()
            : null,
    ]);
    const admins = staticRecipients?.admins || [];
    const hr = staticRecipients?.hr || null;
    const emails = dedupeEmails([
        ...admins.map((a) => pickCompanyAddress(a || {})),
        pickCompanyAddress(hr || {}),
        pickCompanyAddress(hod || {}),
    ]);
    return { admins, hr, hod, emails };
};

const buildCompanyDocuments = (company) => collectCompanyExpiryDocuments(company);

/** Parse keys like `company:<mongoId>:owner:0:passport` */
const parseCompanyOwnerDocKey = (docKey = "") => {
    const ownerKeys = COMPANY_OWNER_EXPIRY_FIELDS.map((f) => f.key).join("|");
    const m = String(docKey).match(new RegExp(`^company:[^:]+:owner:(\\d+):(${ownerKeys})$`));
    if (!m) return null;
    return { ownerIdx: Number(m[1]), fieldKey: m[2] };
};

const normalizeComparableOwnerName = (name) =>
    String(name || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");

const ownerDocIdentifierForFingerprint = (owner, fieldKey) => {
    if (!owner || typeof owner !== "object") return "";
    if (fieldKey === "passport") return String(owner?.passport?.number || "").trim().toLowerCase();
    if (fieldKey === "visa") return String(owner?.visa?.number || "").trim().toLowerCase();
    if (fieldKey === "visitVisa") return String(owner?.visitVisa?.number || "").trim().toLowerCase();
    if (fieldKey === "employmentVisa") return String(owner?.employmentVisa?.number || "").trim().toLowerCase();
    if (fieldKey === "spouseVisa") return String(owner?.spouseVisa?.number || "").trim().toLowerCase();
    if (fieldKey === "emiratesId") return String(owner?.emiratesId?.number || "").trim().toLowerCase();
    if (fieldKey === "labourCard") return String(owner?.labourCard?.number || "").trim().toLowerCase();
    if (fieldKey === "medical") return String(owner?.medical?.number || owner?.medical?.policyNumber || "").trim().toLowerCase();
    if (fieldKey === "drivingLicense")
        return String(owner?.drivingLicense?.number || "").trim().toLowerCase();
    return "";
};

/**
 * Same owner + same document lane + same calendar expiry → one reminder task even if duplicated on many companies.
 * Prefer canonical company row with lowest human `companyId` (EST-001 before EST-002), then mongo _id.
 */
const ownerLinkedExpiryFingerprint = (owner, fieldKey, expiryDate) => {
    const nm = normalizeComparableOwnerName(owner?.name);
    const expLabel = formatExpiryDateLabel(expiryDate);
    const idPart = ownerDocIdentifierForFingerprint(owner, fieldKey);
    return `olf::${nm}::${fieldKey}::${idPart}::${expLabel}`;
};

const pickBetterCanonicalCompany = (a, b) => {
    const ahum = String(a.companyHumanId || "").trim();
    const bhum = String(b.companyHumanId || "").trim();
    if (ahum && !bhum) return a;
    if (!ahum && bhum) return b;
    if (ahum && bhum && ahum !== bhum) {
        return ahum.localeCompare(bhum) < 0 ? a : b;
    }
    return String(a.companyMongoId).localeCompare(String(b.companyMongoId)) < 0 ? a : b;
};

/** @returns Map<fingerprint, { companyMongoId, companyHumanId, ownerIdx, fieldKey }> */
const buildCanonicalOwnerExpiryTargets = (companies) => {
    const canon = new Map();
    for (const company of companies) {
        const docs = buildCompanyDocuments(company);
        const humanId = String(company.companyId || "").trim();
        for (const doc of docs) {
            const parsed = parseCompanyOwnerDocKey(doc.key);
            if (!parsed) continue;
            const days = getDaysUntil(doc.expiryDate);
            if (days == null || !isExpiryTaskWindow(days)) continue;
            const owner = company?.owners?.[parsed.ownerIdx];
            if (!owner) continue;
            const fp = ownerLinkedExpiryFingerprint(owner, parsed.fieldKey, doc.expiryDate);
            const row = {
                companyMongoId: company._id,
                companyHumanId: humanId,
                ownerIdx: parsed.ownerIdx,
                fieldKey: parsed.fieldKey,
            };
            if (!canon.has(fp)) canon.set(fp, row);
            else canon.set(fp, pickBetterCanonicalCompany(row, canon.get(fp)));
        }
    }
    return canon;
};

const resolveOwnerExpiryReminderMeta = (company, doc, canonicalOwnerTargets) => {
    const parsedOwner = parseCompanyOwnerDocKey(doc.key);
    if (!parsedOwner) {
        return { skipDuplicateOwnerReminder: false, ownerTabMeta: null, countsForActiveSet: true };
    }
    const ownerRow = company?.owners?.[parsedOwner.ownerIdx];
    const fp = ownerLinkedExpiryFingerprint(ownerRow, parsedOwner.fieldKey, doc.expiryDate);
    const winner = canonicalOwnerTargets.get(fp);
    if (!winner || String(winner.companyMongoId) !== String(company._id)) {
        return { skipDuplicateOwnerReminder: true, ownerTabMeta: null, countsForActiveSet: false };
    }
    return {
        skipDuplicateOwnerReminder: false,
        ownerTabMeta: { idx: parsedOwner.ownerIdx, fieldKey: parsedOwner.fieldKey },
        countsForActiveSet: true,
    };
};

const syncCompanyDocumentExpiryDashboard = async (company, canonicalOwnerTargets, recipients) => {
    const docs = buildCompanyDocuments(company);
    const activeTaskWindowExtra1 = new Set();

    for (const doc of docs) {
        const daysUntil = getDaysUntil(doc.expiryDate);
        if (daysUntil == null || !isExpiryHrTaskDueForDoc(daysUntil, { isCertificate: doc.isCertificate })) continue;
        const expLabel = formatExpiryDateLabel(doc.expiryDate);
        const extra1 = `Expiry follow-up required: ${doc.label}${expLabel ? ` (Exp: ${expLabel})` : ""}`;
        const { countsForActiveSet } = resolveOwnerExpiryReminderMeta(company, doc, canonicalOwnerTargets);
        if (!countsForActiveSet) continue;
        activeTaskWindowExtra1.add(extra1);
    }

    await removeObsoleteExpiryActions({
        requestId: company._id,
        requestType: "Document Expiry Reminder",
        allowedExtra1Set: activeTaskWindowExtra1,
    });
    await purgeNonHrExpiryTasks({
        requestId: company._id,
        requestType: "Document Expiry Reminder",
        hrObjectId: recipients.hr?._id || null,
    });

    for (const doc of docs) {
        const days = getDaysUntil(doc.expiryDate);
        if (days == null || !isExpiryHrTaskDueForDoc(days, { isCertificate: doc.isCertificate }) || !recipients.hr?._id) continue;

        const expLabel = formatExpiryDateLabel(doc.expiryDate);
        const extra1 = `Expiry follow-up required: ${doc.label}${expLabel ? ` (Exp: ${expLabel})` : ""}`;
        const extra2 = `${company.name || ""} (${company.companyId || ""})`;
        const { skipDuplicateOwnerReminder, ownerTabMeta } = resolveOwnerExpiryReminderMeta(
            company,
            doc,
            canonicalOwnerTargets
        );
        if (skipDuplicateOwnerReminder) continue;

        const extra3 =
            ownerTabMeta != null
                ? JSON.stringify({
                      ownerExpiryDedupe: true,
                      ownerTabIndex: ownerTabMeta.idx,
                      ownerDocField: ownerTabMeta.fieldKey,
                  })
                : doc.isCertificate && doc.documentRow
                  ? JSON.stringify(
                        resolveCompanyCertificateExpiryNavigationMeta(company, doc.documentRow) || {},
                    )
                  : undefined;
        await ensureDashboardAction({
            assignedTo: recipients.hr._id,
            assignedToEmpId: recipients.hr.employeeId,
            requestId: company._id,
            subjectEmployeeId: company.companyId,
            subjectName: company.name,
            extra1,
            extra2,
            extra3,
        });
    }
};

/**
 * Sync HR task-bar rows for one company immediately after save (and drop stale/non-canonical copies).
 */
export const reconcileCompanyDocumentExpiryDashboard = async (companyMongoId) => {
    if (!companyMongoId) return;
    const recipients = await getFlowchartRecipientBundle();
    const [scanCompanies, companyRows] = await Promise.all([
        loadCompaniesForExpiryScan(),
        loadCompaniesForExpiryScanByIds([companyMongoId]),
    ]);
    const canonicalOwnerTargets = buildCanonicalOwnerExpiryTargets(scanCompanies);
    const company = companyRows[0];
    if (!company) return;
    await syncCompanyDocumentExpiryDashboard(company, canonicalOwnerTargets, recipients);
};

/**
 * Rebuild all company document-expiry dashboard tasks (no emails). Used when HR opens notifications.
 */
export const syncAllCompaniesDocumentExpiryDashboard = async () => {
    const recipients = await getFlowchartRecipientBundle();
    const scanCompanies = await loadCompaniesForExpiryScan();
    const canonicalOwnerTargets = buildCanonicalOwnerExpiryTargets(scanCompanies);

    const cores = await Company.find({}).select("_id").lean().maxTimeMS(15000);

    for (const core of cores) {
        try {
            const [company] = await loadCompaniesForExpiryScanByIds([core._id]);
            if (!company) continue;
            await syncCompanyDocumentExpiryDashboard(company, canonicalOwnerTargets, recipients);
        } catch (err) {
            console.warn(
                "[syncAllCompaniesDocumentExpiryDashboard]",
                String(core._id),
                err?.message || err,
            );
        }
    }
};

const processCompanyReminders = async () => {
    const companies = await loadCompaniesForExpiryScan();
    const recipients = await getFlowchartRecipientBundle();
    const canonicalOwnerTargets = buildCanonicalOwnerExpiryTargets(companies);

    for (const company of companies) {
        await syncCompanyDocumentExpiryDashboard(company, canonicalOwnerTargets, recipients);

        const docs = buildCompanyDocuments(company);
        for (const doc of docs) {
            const days = getDaysUntil(doc.expiryDate);
            if (days == null) continue;

            const { skipDuplicateOwnerReminder, ownerTabMeta } = resolveOwnerExpiryReminderMeta(
                company,
                doc,
                canonicalOwnerTargets
            );

            const emailStage = getEmailReminderStageMarker(days);
            if (emailStage == null) continue;

            if (skipDuplicateOwnerReminder) continue;

            const alreadySent = await wasReminderSent({
                targetType: "company",
                targetId: String(company._id),
                docKey: doc.key,
                daysBefore: emailStage,
            });
            if (alreadySent) continue;

            const stageLabel = getReminderStageLabel(emailStage);
            const location = buildCompanyExpiryEmailLocation({
                company,
                doc,
                ownerTabMeta,
            });
            const subject = `Company document expiry ${stageLabel}: ${company.name}`;
            const html = `
                <div style="font-family: Arial, sans-serif; line-height: 1.6; color:#0f172a;">
                    <h3 style="margin:0 0 12px;">Company Document Expiry Reminder (${escapeExpiryEmailHtml(stageLabel)})</h3>
                    <p style="margin:0 0 8px;"><strong>Company:</strong> ${escapeExpiryEmailHtml(company.name || "N/A")} (${escapeExpiryEmailHtml(company.companyId || "N/A")})</p>
                    <p style="margin:0 0 8px;"><strong>Document:</strong> ${escapeExpiryEmailHtml(doc.label)}</p>
                    <p style="margin:0 0 8px;"><strong>Expiry Date:</strong> ${escapeExpiryEmailHtml(new Date(doc.expiryDate).toLocaleDateString("en-GB"))}</p>
                    <p style="margin:0 0 8px;"><strong>Current lead time:</strong> ${escapeExpiryEmailHtml(days)} day(s) before expiry.</p>
                    ${renderExpiryEmailLocationBlock(location)}
                    <p style="margin-top:12px;color:#555;font-size:13px;"><em>This email is sent to the designated <strong>Admin Officer</strong> and <strong>HR</strong> on the organizational flowchart. Follow-up tasks are assigned only to designated HR.</em></p>
                </div>
            `;

            await sendExpiryReminderEmail({
                to: recipients.emails,
                subject,
                html,
            });

            await markReminderSent({
                targetType: "company",
                targetId: String(company._id),
                docKey: doc.key,
                daysBefore: emailStage,
                expiryDate: doc.expiryDate,
                metadata: {
                    companyName: company.name,
                    docLabel: doc.label,
                    detailUrl: location.detailUrl,
                },
            });
        }
    }
};

export const buildEmployeeDocumentMap = async (employeeIds) => {
    const [passports, visas, emiratesIds, labourCards, medicalIns, drivingLic] = await Promise.all([
        EmployeePassport.find({ employeeId: { $in: employeeIds } }).select("employeeId number expiryDate").lean(),
        EmployeeVisa.find({ employeeId: { $in: employeeIds } }).select("employeeId visit employment spouse").lean(),
        EmployeeEmiratesId.find({ employeeId: { $in: employeeIds } }).select("employeeId emiratesId").lean(),
        EmployeeLabourCard.find({ employeeId: { $in: employeeIds } }).select("employeeId labourCard").lean(),
        EmployeeMedicalInsurance.find({ employeeId: { $in: employeeIds } }).select("employeeId medicalInsurance").lean(),
        EmployeeDrivingLicense.find({ employeeId: { $in: employeeIds } }).select("employeeId drivingLicenceDetails").lean(),
    ]);

    const map = new Map();
    employeeIds.forEach((id) => map.set(id, []));

    passports.forEach((p) => {
        if (p?.expiryDate) map.get(p.employeeId)?.push({ key: `passport`, label: "Passport", expiryDate: p.expiryDate });
    });
    visas.forEach((v) => {
        if (v?.visit?.expiryDate) map.get(v.employeeId)?.push({ key: "visa:visit", label: "Visit Visa", expiryDate: v.visit.expiryDate });
        if (v?.employment?.expiryDate) map.get(v.employeeId)?.push({ key: "visa:employment", label: "Employment Visa", expiryDate: v.employment.expiryDate });
        if (v?.spouse?.expiryDate) map.get(v.employeeId)?.push({ key: "visa:spouse", label: "Spouse Visa", expiryDate: v.spouse.expiryDate });
    });
    emiratesIds.forEach((e) => {
        if (e?.emiratesId?.expiryDate) map.get(e.employeeId)?.push({ key: "emirates-id", label: "Emirates ID", expiryDate: e.emiratesId.expiryDate });
    });
    labourCards.forEach((l) => {
        if (l?.labourCard?.expiryDate) map.get(l.employeeId)?.push({ key: "labour-card", label: "Labour Card", expiryDate: l.labourCard.expiryDate });
    });
    medicalIns.forEach((m) => {
        if (m?.medicalInsurance?.expiryDate) map.get(m.employeeId)?.push({ key: "medical-insurance", label: "Medical Insurance", expiryDate: m.medicalInsurance.expiryDate });
    });
    drivingLic.forEach((d) => {
        if (d?.drivingLicenceDetails?.expiryDate) map.get(d.employeeId)?.push({ key: "driving-license", label: "Driving License", expiryDate: d.drivingLicenceDetails.expiryDate });
    });

    return map;
};

/**
 * Rebuild pending employee document-expiry dashboard tasks for one employee (no emails).
 * Drops rows outside ≤ today+10 (or overdue) after renew/edit.
 */
export const reconcileEmployeeDocumentExpiryDashboard = async (employeeMongoIdOrHumanId) => {
    if (!employeeMongoIdOrHumanId) return;

    const idStr = String(employeeMongoIdOrHumanId).trim();
    let employee = await EmployeeBasic.findById(idStr)
        .select("_id employeeId firstName lastName documents contractExpiryDate primaryReportee status profileStatus")
        .lean()
        .catch(() => null);

    if (!employee) {
        employee = await EmployeeBasic.findOne({ employeeId: idStr })
            .select("_id employeeId firstName lastName documents contractExpiryDate primaryReportee status profileStatus")
            .lean();
    }
    if (!employee) return;
    return syncOneEmployeeExpiryDashboardTasks(employee);
};

const syncOneEmployeeExpiryDashboardTasks = async (employee) => {
    if (!employee?._id || !isEmployeeActiveForNotifications(employee)) {
        if (employee?._id) {
            await removeObsoleteExpiryActions({
                requestId: employee._id,
                requestType: "Employee Document Expiry Reminder",
                allowedExtra1Set: new Set(),
            });
        }
        return;
    }

    const map = await buildEmployeeDocumentMap([employee.employeeId]);
    const docs = [...(map.get(employee.employeeId) || [])];
    (employee.documents || []).forEach((d, idx) => {
        if (!d?.expiryDate || isArchivedOrStaleCompanyExpiryRow(d)) return;
        docs.push({
            key: `manual:${d?._id || idx}`,
            label: buildEmployeeManualDocumentExpiryLabel(d),
            expiryDate: d.expiryDate,
            isCertificate: String(d?.context || "").toLowerCase() === "certificate",
            documentRow: d,
        });
    });
    if (employee?.contractExpiryDate) {
        docs.push({
            key: "contract-expiry",
            label: "Contract Expiry",
            expiryDate: employee.contractExpiryDate,
        });
    }

    const activeTaskWindowExtra1 = new Set(
        docs
            .filter((doc) =>
                isExpiryHrTaskDueForDoc(getDaysUntil(doc.expiryDate), {
                    isCertificate: doc.isCertificate,
                }),
            )
            .map((doc) => {
                const expLabel = formatExpiryDateLabel(doc.expiryDate);
                return `Expiry follow-up required: ${doc.label}${expLabel ? ` (Exp: ${expLabel})` : ""}`;
            }),
    );

    await removeObsoleteExpiryActions({
        requestId: employee._id,
        requestType: "Employee Document Expiry Reminder",
        allowedExtra1Set: activeTaskWindowExtra1,
    });

    const recipients = await getEmployeeRecipientBundle(employee);
    await purgeNonHrExpiryTasks({
        requestId: employee._id,
        requestType: "Employee Document Expiry Reminder",
        hrObjectId: recipients.hr?._id || null,
    });

    const subjectName =
        `${employee.firstName || ""} ${employee.lastName || ""}`.trim() || employee.employeeId;

    for (const doc of docs) {
        const days = getDaysUntil(doc.expiryDate);
        if (days == null) continue;
        if (!isExpiryHrTaskDueForDoc(days, { isCertificate: doc.isCertificate }) || !recipients.hr?._id) {
            continue;
        }
        const expLabel = formatExpiryDateLabel(doc.expiryDate);
        const extra1 = `Expiry follow-up required: ${doc.label}${expLabel ? ` (Exp: ${expLabel})` : ""}`;
        const extra2 = `${subjectName} (${employee.employeeId})`;
        await ensureDashboardAction({
            assignedTo: recipients.hr._id,
            assignedToEmpId: recipients.hr.employeeId,
            requestId: employee._id,
            subjectEmployeeId: employee.employeeId,
            subjectName,
            extra1,
            extra2,
            requestType: "Employee Document Expiry Reminder",
        });
    }
};

const processEmployeeReminders = async () => {
    const employees = await EmployeeBasic.find({ 
        employeeId: { $ne: "VEGA-HR-0000" }, 
        profileStatus: "active",
        status: { $ne: "Left User" } 
    })
        .select("_id employeeId firstName lastName documents contractExpiryDate primaryReportee")
        .lean();
    const employeeIds = employees.map((e) => e.employeeId);
    const map = await buildEmployeeDocumentMap(employeeIds);

    for (const employee of employees) {
        if (!isEmployeeActiveForNotifications(employee)) continue;
        const docs = [...(map.get(employee.employeeId) || [])];
        (employee.documents || []).forEach((d, idx) => {
            if (!d?.expiryDate || isArchivedOrStaleCompanyExpiryRow(d)) return;
            docs.push({
                key: `manual:${d?._id || idx}`,
                label: buildEmployeeManualDocumentExpiryLabel(d),
                expiryDate: d.expiryDate,
                isCertificate: String(d?.context || "").toLowerCase() === "certificate",
                documentRow: d,
            });
        });
        if (employee?.contractExpiryDate) {
            docs.push({
                key: "contract-expiry",
                label: "Contract Expiry",
                expiryDate: employee.contractExpiryDate,
            });
        }

        const activeTaskWindowExtra1 = new Set(
            docs
                .filter((doc) =>
                    isExpiryHrTaskDueForDoc(getDaysUntil(doc.expiryDate), {
                        isCertificate: doc.isCertificate,
                    }),
                )
                .map((doc) => {
                    const expLabel = formatExpiryDateLabel(doc.expiryDate);
                    return `Expiry follow-up required: ${doc.label}${expLabel ? ` (Exp: ${expLabel})` : ""}`;
                })
        );
        await removeObsoleteExpiryActions({
            requestId: employee._id,
            requestType: "Employee Document Expiry Reminder",
            allowedExtra1Set: activeTaskWindowExtra1,
        });

        const recipients = await getEmployeeRecipientBundle(employee);
        await purgeNonHrExpiryTasks({
            requestId: employee._id,
            requestType: "Employee Document Expiry Reminder",
            hrObjectId: recipients.hr?._id || null,
        });
        const subjectName = `${employee.firstName || ""} ${employee.lastName || ""}`.trim() || employee.employeeId;

        for (const doc of docs) {
            const days = getDaysUntil(doc.expiryDate);
            if (days == null) continue;

            const expLabel = formatExpiryDateLabel(doc.expiryDate);
            const extra1 = `Expiry follow-up required: ${doc.label}${expLabel ? ` (Exp: ${expLabel})` : ""}`;
            const extra2 = `${subjectName} (${employee.employeeId})`;

            if (isExpiryHrTaskDueForDoc(days, { isCertificate: doc.isCertificate }) && recipients.hr?._id) {
                await ensureDashboardAction({
                    assignedTo: recipients.hr._id,
                    assignedToEmpId: recipients.hr.employeeId,
                    requestId: employee._id,
                    subjectEmployeeId: employee.employeeId,
                    subjectName,
                    extra1,
                    extra2,
                    requestType: "Employee Document Expiry Reminder",
                });
            }

            const docKey = `employee:${employee.employeeId}:${doc.key}`;
            const emailStage = getEmailReminderStageMarker(days);
            if (emailStage == null) continue;

            const alreadySent = await wasReminderSent({
                targetType: "employee",
                targetId: String(employee._id),
                docKey,
                daysBefore: emailStage,
            });
            if (alreadySent) continue;

            const stageLabel = getReminderStageLabel(emailStage);
            const location = buildEmployeeExpiryEmailLocation({ employee, doc });
            const subject = `Employee document expiry ${stageLabel}: ${subjectName}`;
            const html = `
                <div style="font-family: Arial, sans-serif; line-height: 1.6; color:#0f172a;">
                    <h3 style="margin:0 0 12px;">Employee Document Expiry Reminder (${escapeExpiryEmailHtml(stageLabel)})</h3>
                    <p style="margin:0 0 8px;"><strong>Employee:</strong> ${escapeExpiryEmailHtml(subjectName)} (${escapeExpiryEmailHtml(employee.employeeId)})</p>
                    <p style="margin:0 0 8px;"><strong>Document:</strong> ${escapeExpiryEmailHtml(doc.label)}</p>
                    <p style="margin:0 0 8px;"><strong>Expiry Date:</strong> ${escapeExpiryEmailHtml(new Date(doc.expiryDate).toLocaleDateString("en-GB"))}</p>
                    <p style="margin:0 0 8px;"><strong>Current lead time:</strong> ${escapeExpiryEmailHtml(days)} day(s) before expiry.</p>
                    ${renderExpiryEmailLocationBlock(location)}
                    <p style="margin-top:12px;color:#555;font-size:13px;"><em>This email is sent to <strong>Admin</strong>, designated <strong>HR</strong> on the organizational flowchart, and the employee&rsquo;s <strong>primary reportee</strong>. Follow-up tasks are assigned only to designated HR.</em></p>
                </div>
            `;

            await sendExpiryReminderEmail({
                to: recipients.emails,
                subject,
                html,
            });

            await markReminderSent({
                targetType: "employee",
                targetId: String(employee._id),
                docKey,
                daysBefore: emailStage,
                expiryDate: doc.expiryDate,
                metadata: {
                    employeeId: employee.employeeId,
                    docLabel: doc.label,
                    detailUrl: location.detailUrl,
                },
            });
        }
    }
};

/**
 * Legacy: rows that used `Document Expiry Reminder` for an employee `_id` are retyped to
 * `Employee Document Expiry Reminder` and assigned to the designated Flowchart HR.
 */
const migrateLegacyEmployeeDocExpiryActions = async () => {
    try {
        const hrFlow = await getDepartmentHOD("hr");
        if (!hrFlow?._id) return;

        const pending = await DashboardAction.find({
            requestType: "Document Expiry Reminder",
            status: "Pending",
        })
            .select("_id requestId")
            .lean();

        for (const row of pending) {
            if (!row.requestId) continue;
            const emp = await EmployeeBasic.findById(row.requestId).select("_id status").lean();
            if (!emp) continue;
            if (isLeftUserStatus(emp.status)) {
                await DashboardAction.deleteOne({ _id: row._id });
                continue;
            }
            await DashboardAction.updateOne(
                { _id: row._id },
                {
                    $set: {
                        requestType: "Employee Document Expiry Reminder",
                        assignedTo: hrFlow._id,
                        ...(hrFlow.employeeId ? { assignedToEmpId: hrFlow.employeeId } : {}),
                    },
                }
            );
        }
    } catch (e) {
        console.warn("[migrateLegacyEmployeeDocExpiryActions]", e?.message || e);
    }
};

const processVehicleReminders = async () => {
    const assets = await AssetItem.find({
        vehicleProfileActivationStatus: "active",
        $or: [
            { plateNumber: { $regex: /\S/ } },
            { vehicleBrand: { $exists: true, $ne: "" } },
        ],
    })
        .populate("typeId", "name")
        .select(
            "_id assetId name plateNumber documents vehicleDispositionStatus vehicleProfileActivationStatus nextServiceDate gearOilDueDate",
        )
        .lean();

    const recipients = await getFlowchartRecipientBundle();

    for (const asset of assets) {
        if (!isFleetVehicleAsset(asset)) continue;

        const docs = collectVehicleExpiryDocuments(asset);
        const vehicleLabel = `${asset.name || "Vehicle"} (${asset.assetId || asset._id})`;

        const activeTaskWindowExtra1 = new Set(
            docs
                .filter((doc) => isExpiryHrTaskDueForDoc(getDaysUntil(doc.expiryDate)))
                .map((doc) => {
                    const expLabel = formatExpiryDateLabel(doc.expiryDate);
                    return `Expiry follow-up required: ${doc.label}${expLabel ? ` (Exp: ${expLabel})` : ""}`;
                }),
        );

        await removeObsoleteExpiryActions({
            requestId: asset._id,
            requestType: "Vehicle Document Expiry Reminder",
            allowedExtra1Set: activeTaskWindowExtra1,
        });

        await purgeNonHrExpiryTasks({
            requestId: asset._id,
            requestType: "Vehicle Document Expiry Reminder",
            hrObjectId: recipients.hr?._id || null,
        });

        for (const doc of docs) {
            const days = getDaysUntil(doc.expiryDate);
            if (days == null) continue;

            const expLabel = formatExpiryDateLabel(doc.expiryDate);
            const extra1 = `Expiry follow-up required: ${doc.label}${expLabel ? ` (Exp: ${expLabel})` : ""}`;
            const extra2 = vehicleLabel;
            const extra3 = JSON.stringify({
                activationSubject: "vehicle",
                vehicleMongoId: String(asset._id),
                vehicleDocType: doc.docType,
                focusCard: resolveVehicleExpiryFocusCard(doc.docType),
                vehicleTab: resolveVehicleExpiryTab(doc.docType),
            });

            if (isExpiryHrTaskDueForDoc(days) && recipients.hr?._id) {
                await ensureDashboardAction({
                    assignedTo: recipients.hr._id,
                    assignedToEmpId: recipients.hr.employeeId,
                    requestId: asset._id,
                    subjectEmployeeId: asset.assetId || "",
                    subjectName: asset.name || "Vehicle",
                    extra1,
                    extra2,
                    extra3,
                    requestType: "Vehicle Document Expiry Reminder",
                });
            }

            const docKey = `vehicle:${asset._id}:${doc.key}`;
            const emailStage = getEmailReminderStageMarker(days);
            if (emailStage == null) continue;

            const alreadySent = await wasReminderSent({
                targetType: "vehicle",
                targetId: String(asset._id),
                docKey,
                daysBefore: emailStage,
            });
            if (alreadySent) continue;

            const stageLabel = getReminderStageLabel(emailStage);
            const location = buildVehicleExpiryEmailLocation({ asset, doc });
            const subject = `Vehicle document expiry ${stageLabel}: ${vehicleLabel}`;
            const html = `
                <div style="font-family: Arial, sans-serif; line-height: 1.6; color:#0f172a;">
                    <h3 style="margin:0 0 12px;">Vehicle Document Expiry Reminder (${escapeExpiryEmailHtml(stageLabel)})</h3>
                    <p style="margin:0 0 8px;"><strong>Vehicle:</strong> ${escapeExpiryEmailHtml(vehicleLabel)}</p>
                    <p style="margin:0 0 8px;"><strong>Document:</strong> ${escapeExpiryEmailHtml(doc.label)}</p>
                    <p style="margin:0 0 8px;"><strong>Expiry Date:</strong> ${escapeExpiryEmailHtml(new Date(doc.expiryDate).toLocaleDateString("en-GB"))}</p>
                    <p style="margin:0 0 8px;"><strong>Current lead time:</strong> ${escapeExpiryEmailHtml(days)} day(s) before expiry.</p>
                    ${renderExpiryEmailLocationBlock(location)}
                    <p style="margin-top:12px;color:#555;font-size:13px;"><em>This email is sent to the designated <strong>Admin Officer</strong> and <strong>HR</strong> on the organizational flowchart. Follow-up tasks are assigned only to designated HR.</em></p>
                </div>
            `;

            await sendExpiryReminderEmail({
                to: recipients.emails,
                subject,
                html,
            });

            await markReminderSent({
                targetType: "vehicle",
                targetId: String(asset._id),
                docKey,
                daysBefore: emailStage,
                expiryDate: doc.expiryDate,
                metadata: {
                    assetId: asset.assetId,
                    docLabel: doc.label,
                    detailUrl: location.detailUrl,
                },
            });
        }
    }
};

export const processDocumentExpiryReminders = async () => {
    try {
        await migrateLegacyEmployeeDocExpiryActions();
        await processCompanyReminders();
        await processEmployeeReminders();
        await processVehicleReminders();
    } catch (err) {
        console.error("[processDocumentExpiryReminders] Non-fatal error:", err?.message || err);
    }
};
