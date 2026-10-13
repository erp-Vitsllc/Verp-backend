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

/** Emails already sent for this task's record. Expiry tasks keep only the matching document. */
export async function findEmailsForTask({ ids = [], prefixes = [], focus = '' } = {}) {
    const exact = [...new Set(ids.map((value) => String(value || '').trim()).filter(Boolean))];
    const starts = [...new Set(prefixes.map((value) => String(value || '').trim()).filter(Boolean))];
    if (!exact.length && !starts.length) return [];

    const or = [];
    if (exact.length) or.push({ recordId: { $in: exact } });
    for (const prefix of starts) {
        or.push({ recordId: new RegExp(`^${escapeEmailId(prefix)}:`, 'i') });
    }

    let rows = await EmailNotificationLog.find({ $or: or })
        .sort({ sentAt: -1 })
        .limit(40)
        .select('from to cc subject html sentAt emailType module recordId')
        .lean();

    const needle = String(focus || '').trim().toLowerCase();
    if (needle) {
        const slug = needle.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const narrowed = rows.filter((row) => {
            const hay = `${row.subject || ''} ${row.recordId || ''} ${row.emailType || ''} ${row.html || ''}`.toLowerCase();
            return hay.includes(needle) || (slug.length > 2 && hay.includes(slug));
        });
        if (narrowed.length) rows = narrowed;
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

/** Older assignment logs stored the subject only. Rebuild the same message for the task email view. */
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
