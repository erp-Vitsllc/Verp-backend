import EmailNotificationLog from '../models/EmailNotificationLog.js';
import { emailFrontendUrl } from './resolveFrontendBaseUrl.js';
import { employeeDisplayName } from './resolveEmployeeEmail.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export const ERP_SUBJECT_TAGS = {
    action: '[Action Required]',
    completed: '[Completed]',
    reminder: '[Reminder]',
    information: '[Information]',
};

export function normalizeEmailAddress(raw) {
    return String(raw || '').trim().toLowerCase();
}

export function normalizeRecipientList(input) {
    const list = Array.isArray(input) ? input : input ? [input] : [];
    const seen = new Set();
    const out = [];
    for (const entry of list) {
        const email = normalizeEmailAddress(entry);
        if (!email || seen.has(email)) continue;
        seen.add(email);
        out.push(email);
    }
    return out;
}

/**
 * Merge TO + CC, dedupe across lists, optionally exclude actor / self emails.
 */
export function normalizeErpRecipients({
    to = [],
    cc = [],
    excludeEmails = [],
} = {}) {
    const exclude = new Set(normalizeRecipientList(excludeEmails));
    const toList = normalizeRecipientList(to).filter((e) => !exclude.has(e));
    const toSet = new Set(toList);
    const ccList = normalizeRecipientList(cc).filter((e) => !exclude.has(e) && !toSet.has(e));
    return { to: toList, cc: ccList };
}

export function buildErpSubject({ category, baseSubject }) {
    const tag = ERP_SUBJECT_TAGS[category] || '';
    const subject = String(baseSubject || '').trim();
    if (!tag) return subject;
    if (subject.startsWith(tag)) return subject;
    return `${tag} ${subject}`;
}

export function buildEmailDedupeKey(parts = []) {
    return parts
        .map((p) => String(p ?? '').trim())
        .filter(Boolean)
        .join('|');
}

/**
 * Returns false when the same dedupeKey was sent within reminderWindowMs (default 24h).
 * Permanent dedupe uses reminderWindowMs = 0 (any prior send blocks).
 */
export async function shouldSendErpEmail(dedupeKey, { reminderWindowMs = 0 } = {}) {
    const key = String(dedupeKey || '').trim();
    if (!key) return true;

    const existing = await EmailNotificationLog.findOne({ dedupeKey: key })
        .select('sentAt')
        .lean();
    if (!existing) return true;

    if (!reminderWindowMs) return false;

    const sentAt = existing.sentAt ? new Date(existing.sentAt).getTime() : 0;
    if (!sentAt) return true;
    return Date.now() - sentAt >= reminderWindowMs;
}

const STORED_HTML_LIMIT = 100000;

export function clipStoredEmailHtml(html) {
    const text = String(html || '');
    if (text.length <= STORED_HTML_LIMIT) return text;
    return `${text.slice(0, STORED_HTML_LIMIT)}<!-- truncated -->`;
}

export async function recordErpEmailSent({
    dedupeKey,
    module = '',
    emailType = '',
    recordId = '',
    from = '',
    to = [],
    cc = [],
    subject = '',
    html = '',
    metadata = {},
}) {
    const key = String(dedupeKey || '').trim();
    if (!key) return;

    try {
        await EmailNotificationLog.findOneAndUpdate(
            { dedupeKey: key },
            {
                $set: {
                    module,
                    emailType,
                    recordId: String(recordId || ''),
                    from: String(from || ''),
                    to: normalizeRecipientList(to),
                    cc: normalizeRecipientList(cc),
                    subject: String(subject || ''),
                    html: clipStoredEmailHtml(html),
                    sentAt: new Date(),
                    metadata,
                },
            },
            { upsert: true, new: true },
        );
    } catch (err) {
        if (err?.code === 11000) return;
        console.warn('[emailDispatch] record failed:', err?.message || err);
    }
}

/** Keep a copy of an email that was already sent, so the task page can show it. */
export async function rememberSentEmail({
    from = '',
    to = [],
    cc = [],
    subject = '',
    html = '',
    recordId = '',
    module = '',
    emailType = '',
} = {}) {
    const key = buildEmailDedupeKey([
        'task-mail',
        module || emailType || 'mail',
        recordId,
        subject,
        normalizeRecipientList(to).join(','),
        Date.now(),
    ]);
    await recordErpEmailSent({
        dedupeKey: key,
        module,
        emailType: emailType || module,
        recordId,
        from,
        to,
        cc,
        subject,
        html,
        metadata: { shownOnTask: true },
    });
}

function escapeEmailId(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const VEHICLE_SERVICE_TYPES = [
    'Accident Repair',
    'Mechanical Work',
    'Tire Change',
    'Body Work',
    'Oil Service',
    'Car Wash',
    'Taxi Charge',
];

export function serviceTypeFromTaskText(value) {
    const text = String(value || '').toLowerCase();
    return VEHICLE_SERVICE_TYPES.find((type) => text.includes(type.toLowerCase())) || '';
}

function emailIdentityText(row) {
    return `${row?.subject || ''} ${row?.emailType || ''} ${row?.module || ''}`.toLowerCase();
}

/**
 * A vehicle-service task must not list every email for the vehicle.
 * Workflow mail is often stored on the asset id, so tire change, oil service,
 * and document expiry would otherwise appear on the same task.
 */
export function emailBelongsToVehicleService(row, { serviceRecordId = '', serviceReqNo = '', serviceType = '', assetId = '', assetCode = '' } = {}) {
    const recordId = String(row?.recordId || '').trim();
    const identity = emailIdentityText(row);
    if (/document expiry|expiry reminder|expiry follow-up/.test(identity)) return false;

    if (serviceRecordId && recordId === serviceRecordId) return true;
    if (serviceReqNo && recordId.toLowerCase() === String(serviceReqNo).trim().toLowerCase()) return true;

    const type = String(serviceType || '').trim().toLowerCase();
    if (!type || !identity.includes(type)) return false;
    const subject = String(row?.subject || '').toLowerCase();
    if (serviceReqNo && /vsr-\d+/i.test(subject) && !subject.includes(String(serviceReqNo).trim().toLowerCase())) {
        return false;
    }
    const mine = identity.indexOf(type);
    const otherFirst = VEHICLE_SERVICE_TYPES.some((name) => {
        const key = name.toLowerCase();
        if (key === type) return false;
        const at = identity.indexOf(key);
        return at >= 0 && at < mine;
    });
    if (otherFirst) return false;
    const asset = String(assetId || '').trim();
    const code = String(assetCode || '').trim();
    return !recordId || recordId === asset || recordId === serviceRecordId || (code && recordId === code);
}

const EXPIRY_RECORD_TYPES = [
    'registration',
    'insurance',
    'warranty',
    'permit',
    'petrol',
    'toll',
    'mortgage',
    'passport',
    'visa',
    'emirates-id',
    'labour-card',
    'medical-insurance',
    'driving-license',
    'trade-license',
];

/** "Mulkia (Registration) (Exp: 16/10/2026)" → "Mulkia (Registration)". */
export function documentLabelFromExpiryText(value) {
    const raw = String(value || '').trim();
    const match = raw.match(/expiry follow-up required:\s*(.+)$/i);
    if (!match) return '';
    return match[1]
        .replace(/\s*[([\{]\s*exp:\s*[^)\]\}]+[)\]\}]\s*$/i, '')
        .replace(/\s+expiry reminder$/i, '')
        .trim();
}

export function docTypeFromLabel(label) {
    const text = String(label || '').toLowerCase();
    if (!text) return '';
    if (text.includes('mulkia') || text.includes('registration')) return 'registration';
    if (text.includes('insurance')) return 'insurance';
    if (text.includes('warranty')) return 'warranty';
    if (text.includes('permit')) return 'permit';
    if (text.includes('petrol')) return 'petrol';
    if (text.includes('toll')) return 'toll';
    if (text.includes('mortgage')) return 'mortgage';
    if (text.includes('passport')) return 'passport';
    if (text.includes('emirates')) return 'emirates-id';
    if (text.includes('labour')) return 'labour-card';
    if (text.includes('medical')) return 'medical-insurance';
    if (text.includes('driving')) return 'driving-license';
    if (text.includes('trade license')) return 'trade-license';
    if (text.includes('visa')) return 'visa';
    return '';
}

function recordHasDocType(recordId, docType) {
    const type = String(docType || '').trim().toLowerCase();
    if (!type) return false;
    const parts = String(recordId || '').toLowerCase().split(':').filter(Boolean);
    if (parts.includes(type)) return true;
    return parts.join(':').includes(type);
}

/**
 * Expiry mail is stored on the vehicle, employee, or company id.
 * Keep the document this task is about. Service, assignment, and transfer mail stays out.
 */
export function emailBelongsToDocumentExpiry(row, { docLabel = '', docType = '' } = {}) {
    const recordId = String(row?.recordId || '');
    const identity = emailIdentityText(row);
    const html = String(row?.html || '').toLowerCase();
    const expiryMail = /document expiry|expiry reminder|expiry follow-up|documentexpiry/.test(identity)
        || /document expiry|expiry reminder|expiry follow-up/.test(html);
    if (!expiryMail) return false;

    const label = String(docLabel || '').trim().toLowerCase();
    const hay = `${identity} ${recordId.toLowerCase()} ${html}`;
    // The document name in the sent message decides the task. A shorter type
    // inside a longer key (medical-insurance vs insurance) must not hide it.
    if (label && hay.includes(label)) return true;

    const type = String(docType || '').trim().toLowerCase();
    const segment = EXPIRY_RECORD_TYPES.find((name) => recordHasDocType(recordId, name)) || '';
    if (type && segment && segment !== type && !segment.startsWith(`${type}:`) && !type.startsWith(`${segment}:`)) {
        return false;
    }
    if (type && recordHasDocType(recordId, type)) return true;
    if (!segment && type === 'registration' && /\bmulkia\b|\bregistration\b/.test(hay)) return true;
    return false;
}

/** Emails already sent for this task's record. Expiry tasks keep only the matching document. */
export async function findEmailsForTask({ ids = [], prefixes = [], focus = '', requireFocus = false, onlyExpiry = false } = {}) {
    const exact = [...new Set(ids.map((value) => String(value || '').trim()).filter(Boolean))];
    const starts = [...new Set(prefixes.map((value) => String(value || '').trim()).filter(Boolean))];
    const needle = String(focus || '').trim().toLowerCase();
    if (requireFocus && !needle) return [];
    if (!exact.length && !starts.length) return [];

    const or = [];
    if (exact.length) or.push({ recordId: { $in: exact } });
    for (const prefix of starts) {
        or.push({ recordId: new RegExp(`^${escapeEmailId(prefix)}:`, 'i') });
    }

    const recordMatch = { $or: or };
    const query = onlyExpiry
        ? {
            $and: [
                recordMatch,
                {
                    $or: [
                        { emailType: /expiry/i },
                        { module: /expiry/i },
                        { subject: /document expiry|expiry reminder|expiry follow-up/i },
                    ],
                },
            ],
        }
        : recordMatch;

    let rows = await EmailNotificationLog.find(query)
        .sort({ sentAt: -1 })
        .limit(200)
        .select('from to cc subject html sentAt emailType module recordId')
        .lean();

    if (needle) {
        const slug = needle.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const narrowed = rows.filter((row) => {
            const hay = `${row.subject || ''} ${row.recordId || ''} ${row.emailType || ''} ${row.html || ''}`.toLowerCase();
            return hay.includes(needle) || (slug.length > 2 && hay.includes(slug));
        });
        if (narrowed.length) rows = narrowed;
        else if (requireFocus) rows = [];
        else if (starts.length) rows = rows.filter((row) => exact.includes(String(row.recordId || '')));
    }

    const restored = await restoreUnsavedEmailCopies(rows);

    return restored.map((row) => ({
        id: String(row._id),
        from: row.from || '',
        to: Array.isArray(row.to) ? row.to : [],
        cc: Array.isArray(row.cc) ? row.cc : [],
        subject: row.subject || row.emailType || 'Email',
        html: row.html || '',
        sentAt: row.sentAt || row.createdAt || null,
        emailType: row.emailType || row.module || '',
        recordId: row.recordId || '',
    }));
}

function escapeHtmlText(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function stripErpSubjectTag(subject) {
    return String(subject || '').replace(/^\[(Action Required|Completed|Reminder|Information)\]\s*/i, '').trim();
}

function parseAssignmentSubject(subject) {
    const text = stripErpSubjectTag(subject);
    const single = [
        { re: /^Asset Assignment Notification for (.+): (.+) \(([^)]+)\)$/i, self: false, transfer: false, company: false },
        { re: /^New Asset Assigned to You: (.+) \(([^)]+)\)$/i, self: true, transfer: false, company: false, nameFirst: false },
        { re: /^Asset Allocated to (.+): (.+) \(([^)]+)\)$/i, self: false, transfer: false, company: true },
        { re: /^Asset transferred to you: (.+) \(([^)]+)\)$/i, self: true, transfer: true, company: false, nameFirst: false },
        { re: /^Asset transferred to (.+): (.+) \(([^)]+)\)$/i, self: false, transfer: true, company: false },
    ];
    for (const pattern of single) {
        const match = text.match(pattern.re);
        if (!match) continue;
        if (pattern.nameFirst === false) {
            return {
                self: pattern.self,
                transfer: pattern.transfer,
                company: pattern.company,
                bulk: false,
                employeeName: '',
                assetName: match[1].trim(),
                assetCode: match[2].trim(),
            };
        }
        return {
            self: pattern.self,
            transfer: pattern.transfer,
            company: pattern.company,
            bulk: false,
            employeeName: match[1].trim(),
            assetName: match[2].trim(),
            assetCode: match[3].trim(),
        };
    }
    const bulk = [
        { re: /^New Batch Asset Assignment for (.+): (\d+) Items$/i, self: false, transfer: false, company: false },
        { re: /^New Batch Asset Assignment: (\d+) Items Assigned to You$/i, self: true, transfer: false, company: false, countOnly: true },
        { re: /^Asset Allocation for (.+): (\d+) Items$/i, self: false, transfer: false, company: true },
        { re: /^Asset transfer: (\d+) items assigned to you$/i, self: true, transfer: true, company: false, countOnly: true },
        { re: /^Asset transfer: (\d+) items for (.+)$/i, self: false, transfer: true, company: false, countFirst: true },
    ];
    for (const pattern of bulk) {
        const match = text.match(pattern.re);
        if (!match) continue;
        if (pattern.countOnly) {
            return { self: pattern.self, transfer: pattern.transfer, company: pattern.company, bulk: true, employeeName: '', assetCount: match[1] };
        }
        if (pattern.countFirst) {
            return { self: pattern.self, transfer: pattern.transfer, company: pattern.company, bulk: true, employeeName: match[2].trim(), assetCount: match[1] };
        }
        return { self: pattern.self, transfer: pattern.transfer, company: pattern.company, bulk: true, employeeName: match[1].trim(), assetCount: match[2] };
    }
    return null;
}

function assignmentEmailHtml({ parsed, recipientName, category, buttonUrl, pending }) {
    const employeeName = escapeHtmlText(parsed.employeeName);
    const hello = escapeHtmlText(recipientName || 'Employee');
    const assetName = escapeHtmlText(parsed.assetName);
    const assetCode = escapeHtmlText(parsed.assetCode);
    const categoryName = escapeHtmlText(category || 'Asset');
    const who = parsed.self ? 'you' : `<strong>${employeeName}</strong>`;
    const heading = parsed.transfer ? 'Transfer' : parsed.company ? 'Allocation' : 'Assignment';
    const lead = parsed.transfer
        ? `An ${parsed.bulk ? 'asset batch has' : 'asset has'} been <strong>transferred</strong> to ${parsed.self ? 'you' : `<strong>${employeeName}</strong>`}.`
        : `A new ${parsed.bulk ? 'batch of assets has' : 'asset has'} been ${parsed.company ? 'allocated' : 'assigned'} to ${who}.`;
    const table = parsed.bulk
        ? `<tr>
            <td style="padding: 8px 0; color: #64748b; font-size: 13px; text-transform: uppercase; font-weight: bold;">Batch Size</td>
            <td style="padding: 8px 0; font-weight: bold;">${escapeHtmlText(parsed.assetCount)} Items</td>
        </tr>`
        : `<tr>
            <td style="padding: 8px 0; color: #64748b; font-size: 13px; text-transform: uppercase; font-weight: bold;">Asset ID</td>
            <td style="padding: 8px 0; font-weight: bold;">${assetCode}</td>
        </tr>
        <tr>
            <td style="padding: 8px 0; color: #64748b; font-size: 13px; text-transform: uppercase; font-weight: bold;">Asset Name</td>
            <td style="padding: 8px 0; font-weight: bold;">${assetName}</td>
        </tr>
        <tr>
            <td style="padding: 8px 0; color: #64748b; font-size: 13px; text-transform: uppercase; font-weight: bold;">Category</td>
            <td style="padding: 8px 0; font-weight: bold;">${categoryName}</td>
        </tr>`;
    const nextStep = pending
        ? 'Open the asset page in ERP to review the assignment and complete your response after signing in.'
        : 'Open the asset page in ERP to view details and download any handover documents when needed.';
    const safeUrl = escapeHtmlText(buttonUrl);
    return `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1e293b; line-height: 1.6; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background-color: #ffffff;">
            <div style="background-color: #2563eb; color: white; padding: 30px; text-align: center;">
                <h1 style="margin: 0; font-size: 24px;">Asset ${heading}</h1>
            </div>
            <div style="padding: 40px;">
                <p style="font-size: 16px;">Hello ${hello},</p>
                <p>${lead}</p>
                <div style="background-color: #f8fafc; padding: 25px; border-radius: 8px; margin: 25px 0; border: 1px solid #e2e8f0;">
                    <table style="width: 100%; border-collapse: collapse;">${table}</table>
                </div>
                <p style="font-size: 13px; color: #64748b; margin-bottom: 12px;">The handover form (if applicable) is available on the asset page in ERP.</p>
                <p style="font-size: 14px; color: #64748b; margin-bottom: 30px;">${nextStep}</p>
                <div style="text-align: center; margin-top: 30px; margin-bottom: 20px;">
                    <a href="${safeUrl}" style="background-color: #2563eb; color: #ffffff; padding: 16px 36px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block; font-size: 15px;">View in ERP</a>
                </div>
            </div>
            <div style="background-color: #f8fafc; padding: 20px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0;">
                <p style="margin: 0;">This is an automated notification from the VeRP Asset Management System.</p>
            </div>
        </div>
    `;
}

function parseVehicleServiceSubject(subject) {
    const text = String(subject || '').replace(/^\[VeRP\]\s*/i, '').trim();
    const match = text.match(/^Vehicle service\s+[—–-]\s+(.+?):\s*(.+)$/i);
    if (!match) return null;
    const actionLabel = match[1].trim();
    const tail = match[2].trim();
    const assetCode = tail.split(/\s*[·|]\s*/)[0].trim();
    const serviceType = actionLabel.split(/\s+pending with\s+/i)[0].trim() || 'service';
    const stageLabel = actionLabel.includes('—')
        ? actionLabel.split('—').pop().trim()
        : actionLabel;
    return { actionLabel, assetCode, serviceType, stageLabel };
}

function vehicleServiceEmailHtml({ parsed, recipientName, asset, link }) {
    const esc = (value) => escapeHtmlText(value);
    const plate = [asset?.plateEmirate, asset?.plateNumber].filter(Boolean).join(' ').trim();
    const assetLine = `${parsed.assetCode || asset?.assetId || ''}${asset?.name ? ` — ${asset.name}` : ''}`.trim();
    const rows = [
        ['Asset', assetLine],
        plate ? ['Plate', plate] : null,
    ].filter(Boolean);
    const table = rows
        .map(([label, value]) => `<tr><td style="padding:10px 14px;font-size:12px;color:#64748b;vertical-align:top;white-space:nowrap;">${esc(label)}</td><td style="padding:10px 14px;font-weight:600;color:#0f172a;">${esc(value)}</td></tr>`)
        .join('');
    const hello = esc(recipientName || 'there');
    const detail = `You have ${parsed.stageLabel} pending. Please complete it to continue this ${parsed.serviceType}.`;
    return `
        <div style="font-family:Segoe UI,sans-serif;color:#1e293b;line-height:1.6;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
            <div style="background:#0d9488;color:#fff;padding:18px 24px;">
                <h1 style="margin:0;font-size:18px;">${esc(parsed.actionLabel)}</h1>
                <p style="margin:8px 0 0;font-size:13px;opacity:.95;">${esc(parsed.stageLabel)}</p>
            </div>
            <div style="padding:24px;">
                <p>Hello <strong>${hello}</strong>,</p>
                <p style="color:#475569;">${esc(detail)}</p>
                <table style="width:100%;margin:16px 0;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;border-collapse:collapse;">${table}</table>
                <p style="text-align:center;margin:28px 0;">
                    <a href="${esc(link)}" style="background:#0d9488;color:#fff;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:700;display:inline-block;">Open vehicle</a>
                </p>
            </div>
        </div>`;
}

/** Older logs stored the subject only. Rebuild the message for the task email view. */
async function restoreUnsavedEmailCopies(rows) {
    const missing = rows.filter((row) => !String(row.html || '').trim() && parseAssignmentSubject(row.subject));
    if (!missing.length) return rows;

    const AssetItem = (await import('../models/AssetItem.js')).default;
    await import('../models/AssetCategory.js');
    const EmployeeBasic = (await import('../models/EmployeeBasic.js')).default;
    const Employee = (await import('../models/Employee.js')).default;
    const frontendUrl = emailFrontendUrl();

    for (const row of missing) {
        const parsed = parseAssignmentSubject(row.subject);
        if (!parsed) continue;
        let category = 'Asset';
        let detailsId = /^[a-f0-9]{24}$/i.test(String(row.recordId || '')) ? String(row.recordId) : '';
        if (!parsed.bulk && parsed.assetCode) {
            const asset = await AssetItem.findOne({
                $or: [
                    ...(detailsId ? [{ _id: detailsId }] : []),
                    { assetId: parsed.assetCode },
                ],
            }).populate('categoryId', 'name').select('assetId name category categoryId').lean().catch(() => null);
            if (asset) {
                detailsId = String(asset._id);
                category = asset.categoryId?.name || asset.category || 'Asset';
            }
        }
        const recipientEmail = normalizeEmailAddress(Array.isArray(row.to) ? row.to[0] : '');
        const personQuery = recipientEmail
            ? { $or: [{ companyEmail: recipientEmail }, { workEmail: recipientEmail }] }
            : null;
        const person = personQuery
            ? await EmployeeBasic.findOne(personQuery).select('firstName lastName employeeId').lean().catch(() => null)
                || await Employee.findOne(personQuery).select('firstName lastName employeeId').lean().catch(() => null)
            : null;
        const pending = String(row.emailType || '') === 'assignment_pending'
            || /^\[Action Required\]/i.test(String(row.subject || ''));
        const buttonUrl = parsed.bulk || !detailsId
            ? `${frontendUrl}/HRM/Asset`
            : `${frontendUrl}/HRM/Asset/details/${detailsId}`;
        row.html = assignmentEmailHtml({
            parsed,
            recipientName: employeeDisplayName(person),
            category,
            buttonUrl,
            pending,
        });
    }

    const serviceMails = rows.filter((row) => !String(row.html || '').trim() && parseVehicleServiceSubject(row.subject));
    if (serviceMails.length) {
        const AssetItem = (await import('../models/AssetItem.js')).default;
        const EmployeeBasic = (await import('../models/EmployeeBasic.js')).default;
        const frontendUrl = emailFrontendUrl();
        for (const row of serviceMails) {
            const parsed = parseVehicleServiceSubject(row.subject);
            if (!parsed?.assetCode) continue;
            const asset = await AssetItem.findOne({ assetId: parsed.assetCode })
                .select('assetId name plateEmirate plateNumber')
                .lean()
                .catch(() => null);
            const recipientEmail = normalizeEmailAddress(Array.isArray(row.to) ? row.to[0] : '');
            const person = recipientEmail
                ? await EmployeeBasic.findOne({
                    $or: [{ companyEmail: recipientEmail }, { workEmail: recipientEmail }],
                }).select('firstName lastName').lean().catch(() => null)
                : null;
            const first = String(person?.firstName || '').trim();
            row.html = vehicleServiceEmailHtml({
                parsed,
                recipientName: first || employeeDisplayName(person),
                asset,
                link: asset?._id
                    ? `${frontendUrl}/HRM/Asset/Vehicle/details/${asset._id}`
                    : `${frontendUrl}/HRM/Asset/Vehicle`,
            });
        }
    }
    return rows;
}

/**
 * Central ERP email send: recipient normalization, optional dedupe, nodemailer dispatch.
 */
export async function sendErpEmail({
    transporter,
    from,
    to,
    cc = [],
    subject,
    html,
    attachments,
    dedupeKey = '',
    dedupeReminderWindowMs = 0,
    actorEmail = '',
    module = '',
    emailType = '',
    recordId = '',
    metadata = {},
}) {
    if (!transporter) return { sent: false, reason: 'no_transporter' };

    const { to: toList, cc: ccList } = normalizeErpRecipients({
        to,
        cc,
        excludeEmails: actorEmail ? [actorEmail] : [],
    });

    if (!toList.length) return { sent: false, reason: 'no_recipients' };

    const key = String(dedupeKey || '').trim();
    if (key) {
        const allowed = await shouldSendErpEmail(key, {
            reminderWindowMs: dedupeReminderWindowMs,
        });
        if (!allowed) return { sent: false, reason: 'duplicate' };
    }

    try {
        const { isEmailEnabledForEvent } = await import('./notificationEmailPermission.js');
        const eventKey = String(metadata?.eventKey || '').trim();
        const emailOk = await isEmailEnabledForEvent(eventKey, emailType);
        if (!emailOk) return { sent: false, reason: 'email_channel_off' };
    } catch (err) {
        console.warn('[emailDispatch] permission check skipped:', err?.message || err);
    }

    const finalSubject = buildErpSubject({
        category: metadata?.subjectCategory,
        baseSubject: subject,
    });

    await transporter.sendMail({
        from,
        to: toList.join(', '),
        cc: ccList.length ? ccList.join(', ') : undefined,
        subject: finalSubject,
        html,
        ...(attachments?.length ? { attachments } : {}),
    });

    if (key) {
        await recordErpEmailSent({
            dedupeKey: key,
            module,
            emailType,
            recordId,
            from,
            to: toList,
            cc: ccList,
            subject: finalSubject,
            html,
            metadata,
        });
    }

    return { sent: true, to: toList, cc: ccList };
}

export { ONE_DAY_MS };
