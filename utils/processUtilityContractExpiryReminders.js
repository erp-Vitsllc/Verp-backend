import UtilityEntry from '../models/UtilityEntry.js';
import UtilityContractExpiryReminderLog from '../models/UtilityContractExpiryReminderLog.js';
import DashboardAction from '../models/DashboardAction.js';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { sendUtilityContractExpiryEmail } from './sendUtilityContractExpiryEmail.js';

const REQUEST_TYPE = 'Utility Contract Expiry';
/** Notify HR 10 days before, 5 days before, and on the expiry day. */
const STAGES = [10, 5, 0];

/** DashboardAction.requestId is ObjectId — derive a stable id from the reminder key. */
function requestObjectId(key) {
    const hex = crypto.createHash('md5').update(String(key)).digest('hex').slice(0, 24);
    return new mongoose.Types.ObjectId(hex);
}

function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
}

function yearMonthDayKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** Parse stored contractEnd (YYYY-MM-DD or Date) → start-of-day local Date, or null. */
export function parseContractEndDate(raw) {
    if (!raw) return null;
    if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
        return startOfDay(raw);
    }
    const s = String(raw).trim();
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
        const [y, m, d] = s.slice(0, 10).split('-').map(Number);
        if (!y || !m || !d) return null;
        return startOfDay(new Date(y, m - 1, d));
    }
    const parsed = new Date(s);
    if (Number.isNaN(parsed.getTime())) return null;
    return startOfDay(parsed);
}

export function daysUntilContractEnd(contractEnd, today = new Date()) {
    const end = parseContractEndDate(contractEnd);
    if (!end) return null;
    const t = startOfDay(today);
    return {
        daysUntil: Math.round((end - t) / (1000 * 60 * 60 * 24)),
        contractEnd: end,
        contractEndKey: yearMonthDayKey(end),
    };
}

function kindForStage(daysBefore) {
    if (daysBefore === 10) return 't10';
    if (daysBefore === 5) return 't5';
    return 'due';
}

async function wasSent(entryId, contractEndKey, daysBefore) {
    const hit = await UtilityContractExpiryReminderLog.findOne({
        entryId: String(entryId),
        contractEndKey,
        daysBefore,
    })
        .select('_id')
        .lean();
    return Boolean(hit);
}

async function markSent(entryId, contractEndKey, daysBefore, contractEnd) {
    try {
        await UtilityContractExpiryReminderLog.create({
            entryId: String(entryId),
            contractEndKey,
            daysBefore,
            contractEnd,
        });
    } catch (err) {
        if (err?.code !== 11000) throw err;
    }
}

async function createHrBell({ entry, daysBefore, contractEnd, hr }) {
    if (!hr?._id) return;
    const entryId = String(entry._id || entry.id || '');
    const endLabel = contractEnd.toLocaleDateString('en-GB');
    const stageLabel =
        daysBefore === 0
            ? 'expires today'
            : `expires in ${daysBefore} day${daysBefore === 1 ? '' : 's'}`;
    const reminderKey = `${entryId}:${yearMonthDayKey(contractEnd)}:${daysBefore}`;
    const requestId = requestObjectId(reminderKey);
    const values = entry.values || {};
    const titleBits = [entry.type || 'Utility', values.provider].filter(Boolean).join(' · ');

    await DashboardAction.findOneAndUpdate(
        { requestId, requestType: REQUEST_TYPE },
        {
            requestId,
            requestType: REQUEST_TYPE,
            assignedTo: hr._id,
            status: 'Pending',
            subjectEmployee: hr._id,
            subjectName: `${hr.firstName || ''} ${hr.lastName || ''}`.trim() || 'HR',
            requestedByName: 'System',
            extra1: titleBits || 'Utility contract',
            extra2: `Contract ${stageLabel} (${endLabel})`,
            extra3: JSON.stringify({
                entryId,
                utilityType: entry.type || '',
                contractEnd: yearMonthDayKey(contractEnd),
                daysBefore,
                reminderKey,
                detailsPath: `/HRM/Asset/UtilityBills/details/${encodeURIComponent(entryId)}`,
            }),
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );
}

/**
 * Daily scan: Active utility entries with contractEnd → email + HR bell at T-10, T-5, and expiry day.
 */
export async function processUtilityContractExpiryReminders() {
    try {
        const entries = await UtilityEntry.find({ status: 'Active' }).lean();
        if (!entries.length) return;

        const hr = await getDepartmentHOD('hr');
        if (!hr?._id) {
            console.warn('[UtilityContractExpiryReminders] HR HOD not found.');
        }

        for (const entry of entries) {
            const endRaw = entry?.values?.contractEnd;
            const timing = daysUntilContractEnd(endRaw);
            if (!timing) continue;
            if (!STAGES.includes(timing.daysUntil)) continue;

            const entryId = String(entry._id || '');
            if (!entryId) continue;

            const already = await wasSent(entryId, timing.contractEndKey, timing.daysUntil);
            if (already) continue;

            const contractEndLabel = timing.contractEnd.toLocaleDateString('en-GB');
            const kind = kindForStage(timing.daysUntil);

            if (hr) {
                await sendUtilityContractExpiryEmail({
                    recipient: hr,
                    entry,
                    kind,
                    contractEndLabel,
                });
                await createHrBell({
                    entry,
                    daysBefore: timing.daysUntil,
                    contractEnd: timing.contractEnd,
                    hr,
                });
            }

            await markSent(entryId, timing.contractEndKey, timing.daysUntil, timing.contractEnd);
            console.log(
                `[UtilityContractExpiryReminders] ${kind} sent for entry ${entryId} (end ${timing.contractEndKey})`,
            );
        }
    } catch (err) {
        console.error('[processUtilityContractExpiryReminders] Non-fatal error:', err?.message || err);
    }
}
