import UtilityBillPayment from '../models/UtilityBillPayment.js';
import { cascadeDeleteUtilityBill } from './utilityBillAdminDelete.js';

function cleanIds(ids) {
    return [
        ...new Set(
            (Array.isArray(ids) ? ids : [])
                .map((id) => String(id || '').trim())
                .filter(Boolean),
        ),
    ];
}

/**
 * When a Zoho Books bill is gone (deleted / void), remove the matching ERP utility bill.
 */
export async function deleteUtilityBillsForRemovedZohoBills(zohoBillIds = []) {
    const ids = cleanIds(zohoBillIds);
    if (!ids.length) return { deleted: 0, billIds: [] };

    const bills = await UtilityBillPayment.find({
        $or: [
            { zohoBillId: { $in: ids } },
            { zohoBillIds: { $in: ids } },
            { 'zohoLineItems.zohoBillId': { $in: ids } },
        ],
    })
        .select('_id')
        .lean();

    const deletedIds = [];
    for (const bill of bills) {
        const result = await cascadeDeleteUtilityBill(bill._id, { skipArchive: true });
        if (result?.ok) deletedIds.push(String(bill._id));
    }

    if (deletedIds.length) {
        console.log(
            `[ZohoSync] utility bills: removed ${deletedIds.length} ERP bill(s) after Zoho bill delete`,
        );
    }

    return { deleted: deletedIds.length, billIds: deletedIds };
}
