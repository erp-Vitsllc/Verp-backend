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
