import nodemailer from "nodemailer";
import Company from "../models/Company.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import EmployeePassport from "../models/EmployeePassport.js";
import EmployeeVisa from "../models/EmployeeVisa.js";
import EmployeeEmiratesId from "../models/EmployeeEmiratesId.js";
import EmployeeLabourCard from "../models/EmployeeLabourCard.js";
import EmployeeMedicalInsurance from "../models/EmployeeMedicalInsurance.js";
import EmployeeDrivingLicense from "../models/EmployeeDrivingLicense.js";
import DashboardAction from "../models/DashboardAction.js";
import ExpiryReminderLog from "../models/ExpiryReminderLog.js";
import { getDepartmentHOD } from "./getDepartmentHOD.js";
import { getManagementHOD } from "./getManagementHOD.js";
import { resolveEmployeeEmail } from "./resolveEmployeeEmail.js";

const STAGE_1_MARKER = 30;
const STAGE_2_MARKER = 20;
const STAGE_3_MARKER = 10;
const THIRD_REMINDER_TASK_MARKER = -10;

const startOfDay = (d) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
};

const getDaysUntil = (expiryDate) => {
    if (!expiryDate) return null;
    const today = startOfDay(new Date());
    const exp = startOfDay(expiryDate);
    return Math.round((exp - today) / (1000 * 60 * 60 * 24));
};

const getReminderStageMarker = (daysUntilExpiry) => {
    if (daysUntilExpiry == null) return null;
    if (daysUntilExpiry <= 30 && daysUntilExpiry > 20) return STAGE_1_MARKER;
    if (daysUntilExpiry <= 20 && daysUntilExpiry > 10) return STAGE_2_MARKER;
    if (daysUntilExpiry <= 10) return STAGE_3_MARKER;
    return null;
};

const getReminderStageLabel = (marker) => {
    if (marker === STAGE_1_MARKER) return "1st Reminder";
    if (marker === STAGE_2_MARKER) return "2nd Reminder";
    return "3rd Reminder";
};

const formatExpiryDateLabel = (expiryDate) => {
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

/** Company trade licence / establishment / ejari expiry tasks — assignees are Admin/HR on company record. */
const ensureDashboardAction = async ({
    assignedTo,
    assignedToEmpId,
    requestId,
    subjectEmployeeId,
    subjectName,
    extra1,
    extra2,
    requestType = "Document Expiry Reminder",
}) => {
    if (!assignedTo || !requestId) return;
    const exists = await DashboardAction.findOne({
        assignedTo,
        requestId,
        requestType,
        status: "Pending",
        extra1,
    }).lean();
    if (exists) return;

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

const pickCompanyAddress = (emp = {}) =>
    (emp?.companyEmail || "").trim() ||
    resolveEmployeeEmail(emp || {}).email ||
    null;

const getFlowchartRecipientBundle = async () => {
    const [admin, hr, management] = await Promise.all([
        getDepartmentHOD("admincontroller"),
        getDepartmentHOD("hr"),
        getManagementHOD(),
    ]);
    const emails = dedupeEmails([
        pickCompanyAddress(admin || {}),
        pickCompanyAddress(hr || {}),
        pickCompanyAddress(management || {}),
    ]);
    return { admin, hr, management, emails };
};

/** Employee document expiry routing: Admin + HR + employee HOD (primary reportee). */
const getEmployeeRecipientBundle = async (employee) => {
    const [admin, hr, hod] = await Promise.all([
        getDepartmentHOD("admincontroller"),
        getDepartmentHOD("hr"),
        employee?.primaryReportee
            ? EmployeeBasic.findById(employee.primaryReportee)
                .select("employeeId firstName lastName companyEmail workEmail personalEmail email")
                .lean()
            : null,
    ]);
    const emails = dedupeEmails([
        pickCompanyAddress(admin || {}),
        pickCompanyAddress(hr || {}),
        pickCompanyAddress(hod || {}),
    ]);
    return { admin, hr, hod, emails };
};

const buildCompanyDocuments = (company) => {
    const docs = [];
    if (company?.tradeLicenseExpiry) {
        docs.push({
            key: `company:${company._id}:trade-license`,
            label: "Trade License",
            expiryDate: company.tradeLicenseExpiry,
        });
    }
    if (company?.establishmentCardExpiry) {
        docs.push({
            key: `company:${company._id}:establishment-card`,
            label: "Establishment Card",
            expiryDate: company.establishmentCardExpiry,
        });
    }

    (company?.documents || []).forEach((d, idx) => {
        if (!d?.expiryDate) return;
        docs.push({
            key: `company:${company._id}:document:${d?._id || idx}`,
            label: d?.type || "Company Document",
            expiryDate: d.expiryDate,
        });
    });

    (company?.ejari || []).forEach((ej, idx) => {
        if (!ej?.expiryDate) return;
        const subKey = ej?._id != null ? String(ej._id) : `idx-${idx}`;
        docs.push({
            key: `company:${company._id}:ejari:${subKey}`,
            label: ej?.type ? `Ejari — ${ej.type}` : "Ejari",
            expiryDate: ej.expiryDate,
        });
    });

    (company?.insurance || []).forEach((ins, idx) => {
        if (!ins?.expiryDate) return;
        const subKey = ins?._id != null ? String(ins._id) : `idx-${idx}`;
        docs.push({
            key: `company:${company._id}:insurance:${subKey}`,
            label: ins?.type ? `Insurance — ${ins.type}` : "Insurance",
            expiryDate: ins.expiryDate,
        });
    });

    const ownerFields = [
        { key: "passport", label: "Passport" },
        { key: "visa", label: "Visa" },
        { key: "emiratesId", label: "Emirates ID" },
        { key: "medical", label: "Medical Insurance" },
        { key: "drivingLicense", label: "Driving License" },
        { key: "labourCard", label: "Labour Card" },
    ];

    (company?.owners || []).forEach((owner, ownerIdx) => {
        ownerFields.forEach((f) => {
            const exp = owner?.[f.key]?.expiryDate;
            if (!exp) return;
            docs.push({
                key: `company:${company._id}:owner:${ownerIdx}:${f.key}`,
                label: `${owner?.name || "Owner"} - ${f.label}`,
                expiryDate: exp,
            });
        });
    });
    return docs;
};

const processCompanyReminders = async () => {
    const companies = await Company.find({}).select(
        "_id name companyId tradeLicenseExpiry establishmentCardExpiry documents ejari insurance owners"
    ).lean();
    const recipients = await getFlowchartRecipientBundle();

    for (const company of companies) {
        const docs = buildCompanyDocuments(company);
        const activeThirdStageExtra1 = new Set(
            docs
                .filter((doc) => getReminderStageMarker(getDaysUntil(doc.expiryDate)) === STAGE_3_MARKER)
                .map((doc) => {
                    const expLabel = formatExpiryDateLabel(doc.expiryDate);
                    return `Expiry follow-up required: ${doc.label}${expLabel ? ` (Exp: ${expLabel})` : ""}`;
                })
        );

        await removeObsoleteExpiryActions({
            requestId: company._id,
            requestType: "Document Expiry Reminder",
            allowedExtra1Set: activeThirdStageExtra1,
        });

        for (const doc of docs) {
            const days = getDaysUntil(doc.expiryDate);
            const reminderStage = getReminderStageMarker(days);
            if (!reminderStage) continue;

            const alreadySent = await wasReminderSent({
                targetType: "company",
                targetId: String(company._id),
                docKey: doc.key,
                daysBefore: reminderStage,
            });
            if (alreadySent) continue;

            const stageLabel = getReminderStageLabel(reminderStage);
            const subject = `Company document expiry ${stageLabel}: ${company.name}`;
            const html = `
                <div style="font-family: Arial, sans-serif; line-height: 1.6;">
                    <h3>Company Document Expiry Reminder (${stageLabel})</h3>
                    <p><strong>Company:</strong> ${company.name || "N/A"} (${company.companyId || "N/A"})</p>
                    <p><strong>Document:</strong> ${doc.label}</p>
                    <p><strong>Expiry Date:</strong> ${new Date(doc.expiryDate).toLocaleDateString("en-GB")}</p>
                    <p><strong>Current lead time:</strong> ${days} day(s) before expiry.</p>
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
                daysBefore: reminderStage,
                expiryDate: doc.expiryDate,
                metadata: { companyName: company.name, docLabel: doc.label },
            });

            // Create dashboard task only at third reminder stage.
            if (reminderStage === STAGE_3_MARKER) {
                const expLabel = formatExpiryDateLabel(doc.expiryDate);
                const extra1 = `Expiry follow-up required: ${doc.label}${expLabel ? ` (Exp: ${expLabel})` : ""}`;
                const extra2 = `${company.name || ""} (${company.companyId || ""})`;
                if (recipients.admin?._id) {
                    await ensureDashboardAction({
                        assignedTo: recipients.admin._id,
                        assignedToEmpId: recipients.admin.employeeId,
                        requestId: company._id,
                        subjectEmployeeId: company.companyId,
                        subjectName: company.name,
                        extra1,
                        extra2,
                    });
                }
                if (recipients.hr?._id) {
                    await ensureDashboardAction({
                        assignedTo: recipients.hr._id,
                        assignedToEmpId: recipients.hr.employeeId,
                        requestId: company._id,
                        subjectEmployeeId: company.companyId,
                        subjectName: company.name,
                        extra1,
                        extra2,
                    });
                }
                await markReminderSent({
                    targetType: "company",
                    targetId: String(company._id),
                    docKey: doc.key,
                    daysBefore: THIRD_REMINDER_TASK_MARKER,
                    expiryDate: doc.expiryDate,
                    metadata: { taskCreated: true },
                });
            }
        }
    }
};

const buildEmployeeDocumentMap = async (employeeIds) => {
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

const processEmployeeReminders = async () => {
    const employees = await EmployeeBasic.find({ employeeId: { $ne: "VEGA-HR-0000" } })
        .select("_id employeeId firstName lastName documents contractExpiryDate primaryReportee")
        .lean();
    const employeeIds = employees.map((e) => e.employeeId);
    const map = await buildEmployeeDocumentMap(employeeIds);

    for (const employee of employees) {
        const docs = [...(map.get(employee.employeeId) || [])];
        (employee.documents || []).forEach((d, idx) => {
            if (!d?.expiryDate) return;
            docs.push({
                key: `manual:${d?._id || idx}`,
                label: d?.type || "Employee Document",
                expiryDate: d.expiryDate,
            });
        });
        if (employee?.contractExpiryDate) {
            docs.push({
                key: "contract-expiry",
                label: "Contract Expiry",
                expiryDate: employee.contractExpiryDate,
            });
        }

        const activeThirdStageExtra1 = new Set(
            docs
                .filter((doc) => getReminderStageMarker(getDaysUntil(doc.expiryDate)) === STAGE_3_MARKER)
                .map((doc) => {
                    const expLabel = formatExpiryDateLabel(doc.expiryDate);
                    return `Expiry follow-up required: ${doc.label}${expLabel ? ` (Exp: ${expLabel})` : ""}`;
                })
        );
        await removeObsoleteExpiryActions({
            requestId: employee._id,
            requestType: "Employee Document Expiry Reminder",
            allowedExtra1Set: activeThirdStageExtra1,
        });

        const recipients = await getEmployeeRecipientBundle(employee);
        const subjectName = `${employee.firstName || ""} ${employee.lastName || ""}`.trim() || employee.employeeId;

        for (const doc of docs) {
            const days = getDaysUntil(doc.expiryDate);
            const reminderStage = getReminderStageMarker(days);
            if (!reminderStage) continue;

            const docKey = `employee:${employee.employeeId}:${doc.key}`;
            const alreadySent = await wasReminderSent({
                targetType: "employee",
                targetId: String(employee._id),
                docKey,
                daysBefore: reminderStage,
            });
            if (alreadySent) continue;

            const stageLabel = getReminderStageLabel(reminderStage);
            const subject = `Employee document expiry ${stageLabel}: ${subjectName}`;
            const html = `
                <div style="font-family: Arial, sans-serif; line-height: 1.6;">
                    <h3>Employee Document Expiry Reminder (${stageLabel})</h3>
                    <p><strong>Employee:</strong> ${subjectName} (${employee.employeeId})</p>
                    <p><strong>Document:</strong> ${doc.label}</p>
                    <p><strong>Expiry Date:</strong> ${new Date(doc.expiryDate).toLocaleDateString("en-GB")}</p>
                    <p><strong>Current lead time:</strong> ${days} day(s) before expiry.</p>
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
                daysBefore: reminderStage,
                expiryDate: doc.expiryDate,
                metadata: { employeeId: employee.employeeId, docLabel: doc.label },
            });

            // Create dashboard task/notification only at third reminder stage.
            if (reminderStage === STAGE_3_MARKER) {
                const expLabel = formatExpiryDateLabel(doc.expiryDate);
                const extra1 = `Expiry follow-up required: ${doc.label}${expLabel ? ` (Exp: ${expLabel})` : ""}`;
                const extra2 = `${subjectName} (${employee.employeeId})`;
                if (recipients.admin?._id) {
                    await ensureDashboardAction({
                        assignedTo: recipients.admin._id,
                        assignedToEmpId: recipients.admin.employeeId,
                        requestId: employee._id,
                        subjectEmployeeId: employee.employeeId,
                        subjectName,
                        extra1,
                        extra2,
                        requestType: "Employee Document Expiry Reminder",
                    });
                }
                if (recipients.hr?._id) {
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

                if (recipients.hod?._id) {
                    await ensureDashboardAction({
                        assignedTo: recipients.hod._id,
                        assignedToEmpId: recipients.hod.employeeId,
                        requestId: employee._id,
                        subjectEmployeeId: employee.employeeId,
                        subjectName,
                        extra1,
                        extra2,
                        requestType: "Employee Document Expiry Reminder",
                    });
                }

                await markReminderSent({
                    targetType: "employee",
                    targetId: String(employee._id),
                    docKey,
                    daysBefore: THIRD_REMINDER_TASK_MARKER,
                    expiryDate: doc.expiryDate,
                    metadata: { taskCreated: true },
                });
            }
        }
    }
};

/**
 * Older runs stored employee document tasks as `Document Expiry Reminder` assigned to HR/Admin.
 * Pending rows whose `requestId` is an employee `_id` are moved to `Employee Document Expiry Reminder`
 * and assigned to that employee so company vs employee notification UIs stay separated.
 */
const migrateLegacyEmployeeDocExpiryActions = async () => {
    try {
        const pending = await DashboardAction.find({
            requestType: "Document Expiry Reminder",
            status: "Pending",
        })
            .select("_id requestId")
            .lean();

        for (const row of pending) {
            if (!row.requestId) continue;
            const emp = await EmployeeBasic.findById(row.requestId).select("_id").lean();
            if (!emp) continue;
            await DashboardAction.updateOne(
                { _id: row._id },
                {
                    $set: {
                        requestType: "Employee Document Expiry Reminder",
                        assignedTo: emp._id,
                    },
                }
            );
        }
    } catch (e) {
        console.warn("[migrateLegacyEmployeeDocExpiryActions]", e?.message || e);
    }
};

export const processDocumentExpiryReminders = async () => {
    try {
        await migrateLegacyEmployeeDocExpiryActions();
        await processCompanyReminders();
        await processEmployeeReminders();
    } catch (err) {
        console.error("[processDocumentExpiryReminders] Non-fatal error:", err?.message || err);
    }
};
