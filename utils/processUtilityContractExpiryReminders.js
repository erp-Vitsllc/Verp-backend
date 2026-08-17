import UtilityEntry from '../models/UtilityEntry.js';
import UtilityContractExpiryReminderLog from '../models/UtilityContractExpiryReminderLog.js';
import DashboardAction from '../models/DashboardAction.js';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { sendUtilityContractExpiryEmail } from './sendUtilityContractExpiryEmail.js';
import {
    getCalendarPartsInTz,
    getScheduledEmailTimeZone,
    zonedWallTimeToUtc,
} from './scheduleDailyAtMidnight.js';

const REQUEST_TYPE = 'Utility Contract Expiry';
/** No advance T-10 / T-5 emails — only due/overdue (one email + sticky Accounts task). */

function reminderTz() {
    return getScheduledEmailTimeZone();
}

/** DashboardAction.requestId is ObjectId — derive a stable id from the reminder key. */
function requestObjectId(key) {
    const hex = crypto.createHash('md5').update(String(key)).digest('hex').slice(0, 24);
    return new mongoose.Types.ObjectId(hex);
}

function todayStartInReminderTz(now = new Date()) {
    const { year, month, day } = getCalendarPartsInTz(now, reminderTz());
    return zonedWallTimeToUtc({ year, month, day, hour: 0, minute: 0, second: 0 }, reminderTz());
}

function yearMonthDayKey(d) {
    const { year, month, day } = getCalendarPartsInTz(d, reminderTz());
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function escapeRegex(s) {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Stable request id for the sticky Accounts open task (one per utility entry). */
export function utilityContractAccountsRequestId(entryId) {
    return requestObjectId(`utility-contract-accounts:${String(entryId || '').trim()}`);
}

/**
 * Parse stored contractEnd (YYYY-MM-DD or Date) → midnight in reminder TZ (Asia/Dubai), or null.
 * Avoids UTC/server-local off-by-one on date-only strings.
 */
export function parseContractEndDate(raw) {
    if (!raw) return null;
    const tz = reminderTz();
    if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
        const { year, month, day } = getCalendarPartsInTz(raw, tz);
        return zonedWallTimeToUtc({ year, month, day, hour: 0, minute: 0, second: 0 }, tz);
    }
    const s = String(raw).trim();
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
        const [y, m, d] = s.slice(0, 10).split('-').map(Number);
        if (!y || !m || !d) return null;
        return zonedWallTimeToUtc({ year: y, month: m, day: d, hour: 0, minute: 0, second: 0 }, tz);
    }
    const parsed = new Date(s);
    if (Number.isNaN(parsed.getTime())) return null;
    const { year, month, day } = getCalendarPartsInTz(parsed, tz);
    return zonedWallTimeToUtc({ year, month, day, hour: 0, minute: 0, second: 0 }, tz);
}

export function daysUntilContractEnd(contractEnd, today = new Date()) {
    const end = parseContractEndDate(contractEnd);
    if (!end) return null;
    const t = todayStartInReminderTz(today);
    return {
        daysUntil: Math.round((end.getTime() - t.getTime()) / (1000 * 60 * 60 * 24)),
        contractEnd: end,
        contractEndKey: yearMonthDayKey(end),
    };
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

/**
 * Clear Pending Utility Contract Expiry tasks for an entry
 * (renewed contract end, deactivated, or deleted).
 */
export async function clearUtilityContractExpiryNotifications(
    entryId,
    reason = 'Contract renewed or account deactivated',
) {
    const id = String(entryId || '').trim();
    if (!id) return;

    const stickyId = utilityContractAccountsRequestId(id);
    await DashboardAction.updateMany(
        {
            requestType: REQUEST_TYPE,
            status: 'Pending',
            $or: [
                { requestId: stickyId },
                { extra3: { $regex: `"entryId"\\s*:\\s*"${escapeRegex(id)}"` } },
            ],
        },
        {
            $set: {
                status: 'Approved',
                actionedDate: new Date(),
                comment: reason,
            },
        },
    );
}

async function upsertAccountsSticky({ entry, contractEnd, daysUntil, accounts }) {
    if (!accounts?._id) return;
    const entryId = String(entry._id || entry.id || '');
    if (!entryId) return;

    const endLabel = contractEnd.toLocaleDateString('en-GB', { timeZone: reminderTz() });
    const overdueDays = Math.abs(Number(daysUntil) || 0);
    const stageLabel =
        daysUntil < 0
            ? `expired ${overdueDays} day${overdueDays === 1 ? '' : 's'} ago`
            : 'expires today';
    const requestId = utilityContractAccountsRequestId(entryId);
    const values = entry.values || {};
    const titleBits = [entry.type || 'Utility', values.provider].filter(Boolean).join(' · ');

    await DashboardAction.findOneAndUpdate(
        { requestId, requestType: REQUEST_TYPE },
        {
            requestId,
            requestType: REQUEST_TYPE,
            assignedTo: accounts._id,
            status: 'Pending',
            subjectEmployee: accounts._id,
            subjectName:
                `${accounts.firstName || ''} ${accounts.lastName || ''}`.trim() || 'Accounts',
            requestedByName: 'System',
            extra1: titleBits || 'Utility contract',
            extra2: `Contract ${stageLabel} (${endLabel}) — open until renewed or deactivated`,
            extra3: JSON.stringify({
                entryId,
                utilityType: entry.type || '',
                contractEnd: yearMonthDayKey(contractEnd),
                daysUntil,
                sticky: true,
                detailsPath: `/HRM/Asset/UtilityBills/details/${encodeURIComponent(entryId)}`,
            }),
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );
}

/**
 * Drop every Pending contract-expiry bell that is not a valid due/overdue Active account:
 * deleted utilities, inactive, no contract end, or old advance (T-5 / T-10) leftovers.
 */
export async function clearStaleUtilityContractExpiryNotifications(now = new Date()) {
    const pending = await DashboardAction.find({
        requestType: REQUEST_TYPE,
        status: 'Pending',
    })
        .select('_id requestId extra2 extra3')
        .lean();

    if (!pending.length) return 0;

    const entryIds = [];
    const parsed = pending.map((row) => {
        let meta = {};
        try {
            meta = JSON.parse(row.extra3 || '{}');
        } catch {
            meta = {};
        }
        const entryId = String(meta.entryId || '').trim();
        if (entryId) entryIds.push(entryId);
        return { row, meta, entryId };
    });

    const entries = entryIds.length
        ? await UtilityEntry.find({ _id: { $in: entryIds } })
              .select('_id status values.contractEnd type')
              .lean()
        : [];
    const byId = new Map(entries.map((e) => [String(e._id), e]));

    let closed = 0;
    for (const { row, meta, entryId } of parsed) {
        let reason = '';

        if (!entryId) {
            reason = 'Utility contract reminder missing account — cleared';
        } else {
            const entry = byId.get(entryId);
            if (!entry) {
                reason = 'Utility account deleted — contract reminder cleared';
            } else if (String(entry.status || '') !== 'Active') {
                reason = 'Utility account inactive — contract reminder cleared';
            } else {
                const timing = daysUntilContractEnd(entry?.values?.contractEnd, now);
                if (!timing) {
                    reason = 'No contract end date — contract reminder cleared';
                } else if (timing.daysUntil > 0) {
                    // Old “expires in 5 days” advance leftovers — not allowed anymore.
                    reason = 'Contract not due yet — advance reminder cleared';
                }
            }
        }

        if (
            !reason &&
            (!meta.sticky ||
                Number(meta.daysBefore) > 0 ||
                /expires in\s+\d+\s+day/i.test(String(row.extra2 || '')))
        ) {
            // Leftover T-5 / T-10 advance bells (even if that account is now overdue sticky).
            if (
                Number(meta.daysBefore) > 0 ||
                Number(meta.daysUntil) > 0 ||
                /expires in\s+\d+\s+day/i.test(String(row.extra2 || ''))
            ) {
                reason = 'Advance contract reminder cleared';
            }
        }

        if (!reason) continue;

        await DashboardAction.updateOne(
            { _id: row._id, status: 'Pending' },
            {
                $set: {
                    status: 'Approved',
                    actionedDate: new Date(),
                    comment: reason,
                },
            },
        );
        closed += 1;
    }

    return closed;
}

/**
 * Close leftover Utility Contract Expiry inbox bells.
 * Dashboard pending requests no longer show contract expiry (other utility
 * payment / status-change notifications are unchanged).
 */
export async function closeAllPendingUtilityContractExpiryNotifications(
    reason = 'Utility contract expiry inbox notifications disabled',
) {
    const result = await DashboardAction.updateMany(
        { requestType: REQUEST_TYPE, status: 'Pending' },
        {
            $set: {
                status: 'Approved',
                actionedDate: new Date(),
                comment: reason,
            },
        },
    );
    return result?.modifiedCount || result?.nModified || 0;
}

/**
 * Daily scan: contract expiry inbox bells are disabled.
 * Closes any leftover Pending rows so they do not return. Emails still send once.
 */
export async function processUtilityContractExpiryReminders() {
    try {
        const now = new Date();
        const closed = await closeAllPendingUtilityContractExpiryNotifications();
        if (closed > 0) {
            console.log(
                `[UtilityContractExpiryReminders] closed ${closed} leftover contract-expiry inbox row(s)`,
            );
        }

        const entries = await UtilityEntry.find({ status: 'Active' }).lean();
        const accounts = await getDepartmentHOD('accounts');
        if (!accounts?._id) {
            console.warn('[UtilityContractExpiryReminders] Accounts HOD not found in flowchart.');
            return;
        }

        const dubaiParts = getCalendarPartsInTz(now, reminderTz());
        console.log(
            `[UtilityContractExpiryReminders] scanning ${entries.length} Active entr(y/ies) for ${dubaiParts.year}-${String(dubaiParts.month).padStart(2, '0')}-${String(dubaiParts.day).padStart(2, '0')} (${reminderTz()})`,
        );

        for (const entry of entries) {
            const endRaw = entry?.values?.contractEnd;
            const timing = daysUntilContractEnd(endRaw, now);
            if (!timing) continue;

            const entryId = String(entry._id || '');
            if (!entryId) continue;

            // Only when contract end date is today or past — skip future dates.
            if (timing.daysUntil > 0) continue;

            // Email once per contract-end date when first seen as due/past.
            const already = await wasSent(entryId, timing.contractEndKey, 0);
            if (!already) {
                const kind = timing.daysUntil < 0 ? 'overdue' : 'due';
                await sendUtilityContractExpiryEmail({
                    recipient: accounts,
                    entry,
                    kind,
                    contractEndLabel: timing.contractEnd.toLocaleDateString('en-GB', {
                        timeZone: reminderTz(),
                    }),
                });
                await markSent(entryId, timing.contractEndKey, 0, timing.contractEnd);
                console.log(
                    `[UtilityContractExpiryReminders] ${kind} email → Accounts for entry ${entryId} (end ${timing.contractEndKey})`,
                );
            }
        }
    } catch (err) {
        console.error('[processUtilityContractExpiryReminders] Non-fatal error:', err?.message || err);
    }
}
