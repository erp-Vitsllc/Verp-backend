import EmailNotificationLog from '../models/EmailNotificationLog.js';

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

export async function recordErpEmailSent({
    dedupeKey,
    module = '',
    emailType = '',
    recordId = '',
    to = [],
    cc = [],
    subject = '',
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
                    to: normalizeRecipientList(to),
                    cc: normalizeRecipientList(cc),
                    subject: String(subject || ''),
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
            to: toList,
            cc: ccList,
            subject: finalSubject,
            metadata,
        });
    }

    return { sent: true, to: toList, cc: ccList };
}

export { ONE_DAY_MS };
