import PayrollSettings from '../../models/PayrollSettings.js';
import { ensureAttachmentPersistedToS3 } from '../../utils/s3Upload.js';
import { normalizeStaffTypeKey } from '../../utils/workLocationHelpers.js';

const DEFAULT_RULES = {
    allAttendanceMarked: false,
    allPendingApprovalsCompleted: false,
    overtimeApprovedByHr: false,
    overtimeApprovedByHod: false,
    allSickLeaveApproval: false,
    allAuthorizedLeaves: false,
    allUnauthorizedLeave: false,
    pendingAttendanceApproval: false,
    pendingOtApproval: false,
    pendingAuthorizedLeaveApproval: false,
    pendingUnauthorizedLeaveApproval: false,
    pendingSickLeaveApproval: false,
    pendingLateEarlyCompoffAdjustment: false,
    pendingLeaveApproval: false,
    fine: false,
    reward: false,
    ncr: false,
    loan: false,
    advance: false,
    utilityBillExcess: false,
    salaryProcessReminderToAccounts: false,
    otherDeptHodsPendingApproval: false,
    utilityBill: false,
    salikExcess: false,
    sandwichLeave: false,
    gratuityCalculationRequired: false,
};

const LATE_DEDUCT = new Set(['quarter', 'half', 'full']);
const EMPTY_LATE_RULE = { minutes: null, events: null, deduct: '' };
const REMINDER_DAYS = new Set([5, 10, 20, 30]);
const REMINDER_AUDIENCE_KEYS = new Set([
    'wfAccounts',
    'wfHr',
    'wfAdmin',
    'wfManagement',
    'pendingTaskUser',
]);
const LEGACY_REMINDER_AUDIENCE = {
    accounts: 'wfAccounts',
    hr: 'wfHr',
    pendingEmployee: 'pendingTaskUser',
    primaryReportee: 'pendingTaskUser',
};

export function reminderAudienceList(value) {
    const items = Array.isArray(value) ? value : value ? [value] : [];
    return [
        ...new Set(
            items
                .map((item) => {
                    const raw = String(item || '').trim();
                    if (REMINDER_AUDIENCE_KEYS.has(raw)) return raw;
                    return LEGACY_REMINDER_AUDIENCE[raw] || '';
                })
                .filter(Boolean),
        ),
    ];
}

function toDays(value) {
    if (value === '' || value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

function toLateRules(value, { single = false } = {}) {
    const rows = Array.isArray(value) ? value : [];
    const normalized = rows.slice(0, 20).map((row) => {
        const deduct = String(row?.deduct || '').trim().toLowerCase();
        return {
            title: String(row?.title || '').trim().slice(0, 80),
            minutes: toDays(row?.minutes),
            events: toDays(row?.events),
            deduct: LATE_DEDUCT.has(deduct) ? deduct : '',
        };
    });
    const next = normalized.length ? normalized : [{ ...EMPTY_LATE_RULE }];
    return single ? next.slice(0, 1) : next;
}

function serializeLateRules(value) {
    const rows = Array.isArray(value) ? value : [];
    if (!rows.length) return [{ minutes: '', events: '', deduct: '' }];
    return rows.map((row) => ({
        title: row?.title || '',
        minutes: row?.minutes ?? '',
        events: row?.events ?? '',
        deduct: LATE_DEDUCT.has(String(row?.deduct || '')) ? row.deduct : '',
    }));
}

function toExtraLateRules(value) {
    const rows = Array.isArray(value) ? value : [];
    return rows.slice(0, 20).map((row) => {
        const deduct = String(row?.deduct || '').trim().toLowerCase();
        return {
            title: String(row?.title || '').trim().slice(0, 80),
            minutes: toDays(row?.minutes),
            events: toDays(row?.events),
            deduct: LATE_DEDUCT.has(deduct) ? deduct : '',
        };
    });
}

function serializeExtraLateRules(value) {
    const rows = Array.isArray(value) ? value : [];
    return rows.map((row) => ({
        title: row?.title || '',
        minutes: row?.minutes ?? '',
        events: row?.events ?? '',
        deduct: LATE_DEDUCT.has(String(row?.deduct || '')) ? row.deduct : '',
    }));
}

function toReminders(value) {
    const rows = Array.isArray(value) ? value : [];
    return [0, 1, 2].map((index) => {
        const row = rows[index] || {};
        const days = Number(row.daysBefore);
        return {
            daysBefore: REMINDER_DAYS.has(days) ? days : null,
            forWhom: reminderAudienceList(row.forWhom),
        };
    });
}

function serializeReminders(value) {
    return toReminders(value).map((row) => ({
        daysBefore: row.daysBefore ?? '',
        forWhom: Array.isArray(row.forWhom) ? row.forWhom : reminderAudienceList(row.forWhom),
    }));
}

function parseMonthDay(value) {
    if (value === '' || value == null) return null;
    const s = String(value).trim();
    const iso = s.match(/^\d{4}-\d{2}-(\d{2})/);
    const n = iso ? Number(iso[1]) : Number(s);
    if (!Number.isInteger(n) || n < 1) return null;
    return n;
}

/** Recurring calendar day 1–28 (fits every month). Accepts "15" or a leftover YYYY-MM-DD. */
function toMonthDay(value) {
    const n = parseMonthDay(value);
    if (n == null) return '';
    return String(Math.min(28, n));
}

/** Attendance cutoff can use any calendar day 1–31. */
function toCutoffDay(value) {
    const n = parseMonthDay(value);
    if (n == null) return '';
    return String(Math.min(31, n));
}

function serializePolicyAttachment(att) {
    if (!att || typeof att !== 'object') return null;
    const name = String(att.name || att.fileName || '').trim();
    const publicId = String(att.publicId || '').trim();
    const url = String(att.url || '').trim();
    if (!name && !publicId && !url) return null;
    return {
        name,
        mimeType: String(att.mimeType || att.mime || '').trim(),
        publicId,
        url,
    };
}

export async function resolvePolicyAttachment(incoming, existing, folder) {
    if (incoming === undefined) {
        return serializePolicyAttachment(existing);
    }
    if (incoming === null || incoming === '' || incoming === false) {
        return null;
    }
    if (typeof incoming !== 'object') {
        return serializePolicyAttachment(existing);
    }
    if (incoming.remove === true) {
        return null;
    }
    const hasData = Boolean(incoming.data || incoming.base64);
    const hasRef = Boolean(incoming.publicId || incoming.url);
    if (!hasData && !hasRef) {
        return serializePolicyAttachment(existing);
    }
    const persisted = await ensureAttachmentPersistedToS3(incoming, {
        folder,
        fileName: incoming.name || existing?.name || 'salary-policy-attachment.pdf',
        resourceType: 'raw',
    });
    return serializePolicyAttachment(persisted);
}

export function serializePayrollSettings(doc) {
    const stored = doc?.processingRules?.toObject?.() || doc?.processingRules || {};
    const rules = { ...DEFAULT_RULES, ...stored };
    rules.pendingAttendanceApproval = Boolean(
        rules.pendingAttendanceApproval || rules.allPendingApprovalsCompleted,
    );
    rules.pendingOtApproval = Boolean(
        rules.pendingOtApproval || rules.overtimeApprovedByHr || rules.overtimeApprovedByHod,
    );
    rules.pendingAuthorizedLeaveApproval = Boolean(
        rules.pendingAuthorizedLeaveApproval || rules.allAuthorizedLeaves,
    );
    rules.pendingSickLeaveApproval = Boolean(
        rules.pendingSickLeaveApproval || rules.allSickLeaveApproval,
    );
    return {
        salaryProcessingDate: toMonthDay(doc?.salaryProcessingDate),
        salaryProcessStartMonth: doc?.salaryProcessStartMonth || '',
        salaryCutoffDate: toCutoffDay(doc?.salaryCutoffDate),
        processingRules: rules,
        workingDaysRequiredToEligible: doc?.workingDaysRequiredToEligible ?? null,
        leaveSalaryWorkingDays: doc?.leaveSalaryWorkingDays ?? null,
        workingDaysRequiredForAirTicket: doc?.workingDaysRequiredForAirTicket ?? null,
        authorizedLeaveDeductionDays: doc?.authorizedLeaveDeductionDays ?? null,
        unauthorizedLeaveDeductionDays: doc?.unauthorizedLeaveDeductionDays ?? null,
        lateInRules: serializeLateRules(doc?.lateInRules).slice(0, 1),
        lateOutRules: serializeLateRules(doc?.lateOutRules).slice(0, 1),
        extraLateRules: serializeExtraLateRules(doc?.extraLateRules),
        salaryProcessReminders: serializeReminders(doc?.salaryProcessReminders),
        attachment: serializePolicyAttachment(doc?.attachment),
    };
}

export function buildPayrollPolicyPayload(body, existing) {
    const processingRules = { ...DEFAULT_RULES, ...(existing?.processingRules || {}) };
    const incoming = body?.processingRules && typeof body.processingRules === 'object' ? body.processingRules : {};
    Object.keys(DEFAULT_RULES).forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(incoming, key)) {
            processingRules[key] = Boolean(incoming[key]);
        }
    });

    return {
        salaryProcessingDate: toMonthDay(body?.salaryProcessingDate),
        salaryProcessStartMonth: String(body?.salaryProcessStartMonth || '').trim(),
        salaryCutoffDate: toCutoffDay(body?.salaryCutoffDate),
        processingRules,
        workingDaysRequiredToEligible:
            body?.workingDaysRequiredToEligible !== undefined
                ? toDays(body.workingDaysRequiredToEligible)
                : existing?.workingDaysRequiredToEligible ?? null,
        leaveSalaryWorkingDays:
            body?.leaveSalaryWorkingDays !== undefined
                ? toDays(body.leaveSalaryWorkingDays)
                : existing?.leaveSalaryWorkingDays ?? null,
        workingDaysRequiredForAirTicket:
            body?.workingDaysRequiredForAirTicket !== undefined
                ? toDays(body.workingDaysRequiredForAirTicket)
                : existing?.workingDaysRequiredForAirTicket ?? null,
        authorizedLeaveDeductionDays:
            body?.authorizedLeaveDeductionDays !== undefined
                ? toDays(body.authorizedLeaveDeductionDays)
                : existing?.authorizedLeaveDeductionDays ?? null,
        unauthorizedLeaveDeductionDays:
            body?.unauthorizedLeaveDeductionDays !== undefined
                ? toDays(body.unauthorizedLeaveDeductionDays)
                : existing?.unauthorizedLeaveDeductionDays ?? null,
        lateInRules:
            body?.lateInRules !== undefined
                ? toLateRules(body.lateInRules, { single: true })
                : toLateRules(existing?.lateInRules, { single: true }),
        lateOutRules:
            body?.lateOutRules !== undefined
                ? toLateRules(body.lateOutRules, { single: true })
                : toLateRules(existing?.lateOutRules, { single: true }),
        extraLateRules:
            body?.extraLateRules !== undefined
                ? toExtraLateRules(body.extraLateRules)
                : toExtraLateRules(existing?.extraLateRules),
        salaryProcessReminders:
            body?.salaryProcessReminders !== undefined
                ? toReminders(body.salaryProcessReminders)
                : toReminders(existing?.salaryProcessReminders),
    };
}

export async function getPayrollSettings(req, res) {
    try {
        const doc = await PayrollSettings.findOne({ key: 'default' }).lean();
        return res.status(200).json(serializePayrollSettings(doc));
    } catch (error) {
        console.error('[getPayrollSettings]', error);
        return res.status(500).json({ message: error.message || 'Failed to load payroll settings.' });
    }
}

export async function savePayrollSettings(req, res) {
    try {
        const body = req.body || {};
        const existing = await PayrollSettings.findOne({ key: 'default' }).lean();
        const attachment =
            (await resolvePolicyAttachment(body.attachment, existing?.attachment, 'salary-policy/main')) || {
                name: '',
                mimeType: '',
                publicId: '',
                url: '',
            };
        const payload = {
            key: 'default',
            ...buildPayrollPolicyPayload(body, existing),
            attachment,
            updatedBy: req.user?.id || null,
        };

        const doc = await PayrollSettings.findOneAndUpdate(
            { key: 'default' },
            { $set: payload },
            { upsert: true, new: true, setDefaultsOnInsert: true },
        );

        return res.status(200).json({
            message: 'Payroll settings saved.',
            ...serializePayrollSettings(doc),
        });
    } catch (error) {
        console.error('[savePayrollSettings]', error);
        return res.status(500).json({ message: error.message || 'Failed to save payroll settings.' });
    }
}

export function groupPayrollSettingsKey(locationKey) {
    const key = normalizeStaffTypeKey(locationKey);
    if (!key || key === 'default' || key === 'main') return '';
    return `group:${key}`;
}

export async function getGroupPayrollSettings(req, res) {
    try {
        const locationKey = normalizeStaffTypeKey(req.params?.locationKey);
        const groupKey = groupPayrollSettingsKey(locationKey);
        if (!groupKey) {
            return res.status(400).json({ message: 'Work location is required.' });
        }

        const group = await PayrollSettings.findOne({ key: groupKey }).lean();
        if (group) {
            return res.status(200).json({
                source: 'group',
                locationKey,
                ...serializePayrollSettings(group),
            });
        }

        const main = await PayrollSettings.findOne({ key: 'default' }).lean();
        return res.status(200).json({
            source: 'main',
            locationKey,
            ...serializePayrollSettings(main),
        });
    } catch (error) {
        console.error('[getGroupPayrollSettings]', error);
        return res.status(500).json({ message: error.message || 'Failed to load group salary policy.' });
    }
}

export async function saveGroupPayrollSettings(req, res) {
    try {
        const locationKey = normalizeStaffTypeKey(req.params?.locationKey);
        const groupKey = groupPayrollSettingsKey(locationKey);
        if (!groupKey) {
            return res.status(400).json({ message: 'Work location is required.' });
        }

        const body = req.body || {};
        const existing = await PayrollSettings.findOne({ key: groupKey }).lean();
        const attachment =
            (await resolvePolicyAttachment(
                body.attachment,
                existing?.attachment,
                `salary-policy/${groupKey}`,
            )) || {
                name: '',
                mimeType: '',
                publicId: '',
                url: '',
            };

        const payload = {
            key: groupKey,
            ...buildPayrollPolicyPayload(body, existing),
            attachment,
            updatedBy: req.user?.id || null,
        };

        const doc = await PayrollSettings.findOneAndUpdate(
            { key: groupKey },
            { $set: payload },
            { upsert: true, new: true, setDefaultsOnInsert: true },
        );

        return res.status(200).json({
            message: 'Work location salary policy saved.',
            source: 'group',
            locationKey,
            ...serializePayrollSettings(doc),
        });
    } catch (error) {
        console.error('[saveGroupPayrollSettings]', error);
        return res.status(500).json({ message: error.message || 'Failed to save group salary policy.' });
    }
}
