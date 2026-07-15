import UtilityBillPaymentDay from '../../models/UtilityBillPaymentDay.js';

function normalizeDay(value) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 31) return null;
    return n;
}

/**
 * Upsert payment-day registration after creating / updating a utility entry.
 * POST /api/UtilityBill/payment-day
 */
export const upsertUtilityBillPaymentDay = async (req, res) => {
    try {
        const entryId = String(req.body?.entryId || '').trim();
        const paymentDay = normalizeDay(req.body?.paymentDay);
        if (!entryId) {
            return res.status(400).json({ message: 'entryId is required.' });
        }
        if (paymentDay == null) {
            return res.status(400).json({ message: 'paymentDay must be an integer from 1 to 31.' });
        }

        const status =
            String(req.body?.status || 'Active').toLowerCase() === 'inactive'
                ? 'Inactive'
                : 'Active';

        const doc = await UtilityBillPaymentDay.findOneAndUpdate(
            { entryId },
            {
                entryId,
                paymentDay,
                utilityType: String(req.body?.utilityType || '').trim(),
                accountNo: String(req.body?.accountNo || '').trim(),
                provider: String(req.body?.provider || '').trim(),
                status,
            },
            { upsert: true, new: true, setDefaultsOnInsert: true },
        );

        return res.status(200).json({ ok: true, record: doc });
    } catch (err) {
        console.error('[upsertUtilityBillPaymentDay]', err);
        return res.status(500).json({ message: err?.message || 'Could not save payment day.' });
    }
};

/**
 * Update Active / Inactive so reminders stop for deactivated accounts.
 * PUT /api/UtilityBill/payment-day/:entryId/status
 */
export const updateUtilityBillPaymentDayStatus = async (req, res) => {
    try {
        const entryId = String(req.params?.entryId || '').trim();
        if (!entryId) {
            return res.status(400).json({ message: 'entryId is required.' });
        }
        const status =
            String(req.body?.status || '').toLowerCase() === 'inactive' ? 'Inactive' : 'Active';

        const doc = await UtilityBillPaymentDay.findOneAndUpdate(
            { entryId },
            { status },
            { new: true },
        );
        if (!doc) {
            return res.status(404).json({ message: 'Payment day record not found.' });
        }
        return res.status(200).json({ ok: true, record: doc });
    } catch (err) {
        console.error('[updateUtilityBillPaymentDayStatus]', err);
        return res.status(500).json({ message: err?.message || 'Could not update status.' });
    }
};
