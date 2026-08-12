import mongoose from 'mongoose';
import DashboardAction from '../models/DashboardAction.js';

/**
 * Remove all dashboard / pending-inbox rows for a deleted domain record
 * (Fine, Reward, Loan, Payment, etc.).
 *
 * @param {string|import('mongoose').Types.ObjectId} requestId
 * @param {{ requestTypes?: string[] }} [options]
 * @returns {Promise<{ deletedCount: number }>}
 */
export async function clearDashboardActionsForRequest(requestId, options = {}) {
    const id = String(requestId || '').trim();
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        return { deletedCount: 0 };
    }

    const oid = new mongoose.Types.ObjectId(id);
    const filter = { requestId: oid };

    const types = Array.isArray(options.requestTypes)
        ? options.requestTypes.map((t) => String(t || '').trim()).filter(Boolean)
        : [];
    if (types.length === 1) {
        filter.requestType = types[0];
    } else if (types.length > 1) {
        filter.requestType = { $in: types };
    }

    try {
        const result = await DashboardAction.deleteMany(filter);
        const deletedCount = Number(result?.deletedCount) || 0;
        if (deletedCount > 0) {
            console.log(
                `[clearDashboardActionsForRequest] Removed ${deletedCount} notification(s) for requestId=${id}` +
                    (types.length ? ` types=[${types.join(', ')}]` : ''),
            );
        }
        return { deletedCount };
    } catch (err) {
        console.error(
            '[clearDashboardActionsForRequest] Failed:',
            err?.message || err,
        );
        return { deletedCount: 0 };
    }
}

/**
 * Drop pending-inbox rows whose linked Fine / Reward / Loan / Payment no longer
 * exists, and permanently delete those DashboardAction documents.
 *
 * @param {Array<{ _id?: unknown, requestId?: unknown }>} rows
 * @param {Set<string>|Map<string, unknown>|Record<string, unknown>} existingByRequestId
 * @returns {Promise<typeof rows>}
 */
export async function purgeOrphanDashboardActionRows(rows, existingByRequestId) {
    if (!Array.isArray(rows) || rows.length === 0) return [];

    const hasId =
        existingByRequestId instanceof Set
            ? (id) => existingByRequestId.has(id)
            : existingByRequestId instanceof Map
              ? (id) => existingByRequestId.has(id)
              : (id) =>
                    Object.prototype.hasOwnProperty.call(existingByRequestId || {}, id) &&
                    existingByRequestId[id] != null;

    const kept = [];
    const orphanIds = [];

    for (const row of rows) {
        const requestId = String(row?.requestId || '').trim();
        if (requestId && hasId(requestId)) {
            kept.push(row);
            continue;
        }
        if (row?._id) orphanIds.push(row._id);
    }

    if (orphanIds.length) {
        try {
            const result = await DashboardAction.deleteMany({ _id: { $in: orphanIds } });
            const deletedCount = Number(result?.deletedCount) || 0;
            if (deletedCount > 0) {
                console.log(
                    `[purgeOrphanDashboardActionRows] Removed ${deletedCount} orphan notification(s)`,
                );
            }
        } catch (err) {
            console.error(
                '[purgeOrphanDashboardActionRows] Failed:',
                err?.message || err,
            );
        }
    }

    return kept;
}
