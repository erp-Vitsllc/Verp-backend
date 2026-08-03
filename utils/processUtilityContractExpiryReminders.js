import UtilityEntry from '../models/UtilityEntry.js';
import UtilityContractExpiryReminderLog from '../models/UtilityContractExpiryReminderLog.js';
import DashboardAction from '../models/DashboardAction.js';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { sendUtilityContractExpiryEmail } from './sendUtilityContractExpiryEmail.js';

const REQUEST_TYPE = 'Utility Contract Expiry';
/** Early warnings (email + one-shot bell). Due/overdue use sticky Accounts task. */
const EARLY_STAGES = [10, 5];

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

function escapeRegex(s) {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Stable request id for the sticky Accounts open task (one per utility entry). */
export function utilityContractAccountsRequestId(entryId) {
    return requestObjectId(`utility-contract-accounts:${String(entryId || '').trim()}`);
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
    if (daysBefore < 0) return 'overdue';
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

    const endLabel = contractEnd.toLocaleDateString('en-GB');
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

async function createEarlyWarningBell({ entry, daysBefore, contractEnd, accounts }) {
    if (!accounts?._id) return;
    const entryId = String(entry._id || entry.id || '');
    const endLabel = contractEnd.toLocaleDateString('en-GB');
    const stageLabel = `expires in ${daysBefore} day${daysBefore === 1 ? '' : 's'}`;
    const reminderKey = `${entryId}:${yearMonthDayKey(contractEnd)}:${daysBefore}`;
    const requestId = requestObjectId(reminderKey);
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
 * Daily scan:
 * - T-10 / T-5 → one-shot email + bell to flowchart Accounts
 * - contractEnd <= today → sticky Accounts email/notification until renewed or deactivated
 */
export async function processUtilityContractExpiryReminders() {
    try {
        const entries = await UtilityEntry.find({ status: 'Active' }).lean();
        const accounts = await getDepartmentHOD('accounts');
        if (!accounts?._id) {
            console.warn('[UtilityContractExpiryReminders] Accounts HOD not found in flowchart.');
        }

        const activeOpenIds = new Set();

        for (const entry of entries) {
            const endRaw = entry?.values?.contractEnd;
            const timing = daysUntilContractEnd(endRaw);
            if (!timing) continue;

            const entryId = String(entry._id || '');
            if (!entryId) continue;

            // Sticky Accounts task while contract is due or past.
            if (timing.daysUntil <= 0) {
                activeOpenIds.add(entryId);
                if (accounts) {
                    await upsertAccountsSticky({
                        entry,
                        contractEnd: timing.contractEnd,
                        daysUntil: timing.daysUntil,
                        accounts,
                    });

                    // Email once per contract-end date when first seen as due/past.
                    const already = await wasSent(entryId, timing.contractEndKey, 0);
                    if (!already) {
                        const kind = timing.daysUntil < 0 ? 'overdue' : 'due';
                        await sendUtilityContractExpiryEmail({
                            recipient: accounts,
                            entry,
                            kind,
                            contractEndLabel: timing.contractEnd.toLocaleDateString('en-GB'),
                        });
                        await markSent(
                            entryId,
                            timing.contractEndKey,
                            0,
                            timing.contractEnd,
                        );
                        console.log(
                            `[UtilityContractExpiryReminders] ${kind} → Accounts for entry ${entryId} (end ${timing.contractEndKey})`,
                        );
                    }
                }
                continue;
            }

            // Early warnings only on exact T-10 / T-5 days.
            if (!EARLY_STAGES.includes(timing.daysUntil)) continue;

            const already = await wasSent(entryId, timing.contractEndKey, timing.daysUntil);
            if (already) continue;

            const kind = kindForStage(timing.daysUntil);
            if (accounts) {
                await sendUtilityContractExpiryEmail({
                    recipient: accounts,
                    entry,
                    kind,
                    contractEndLabel: timing.contractEnd.toLocaleDateString('en-GB'),
                });
                await createEarlyWarningBell({
                    entry,
                    daysBefore: timing.daysUntil,
                    contractEnd: timing.contractEnd,
                    accounts,
                });
            }

            await markSent(entryId, timing.contractEndKey, timing.daysUntil, timing.contractEnd);
            console.log(
                `[UtilityContractExpiryReminders] ${kind} → Accounts for entry ${entryId} (end ${timing.contractEndKey})`,
            );
        }

        // Drop sticky tasks when contract is no longer due (renewed / deactivated / missing).
        const pendingSticky = await DashboardAction.find({
            requestType: REQUEST_TYPE,
            status: 'Pending',
            extra3: { $regex: '"sticky"\\s*:\\s*true' },
        })
            .select('_id requestId extra3')
            .lean();

        for (const row of pendingSticky) {
            let entryId = '';
            try {
                entryId = String(JSON.parse(row.extra3 || '{}')?.entryId || '').trim();
            } catch {
                entryId = '';
            }
            if (!entryId || activeOpenIds.has(entryId)) continue;
            await clearUtilityContractExpiryNotifications(
                entryId,
                'Contract no longer due (renewed or account inactive)',
            );
        }
    } catch (err) {
        console.error('[processUtilityContractExpiryReminders] Non-fatal error:', err?.message || err);
    }
}
