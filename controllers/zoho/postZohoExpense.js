import { createExpense } from '../../services/zohoService.js';
import { mapZohoErrorStatus, toFiniteAmount } from './zohoVendorPaymentUtils.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function buildExpensePayload(body = {}) {
    const date = String(body.date || '').trim();
    const accountId = String(body.account_id || body.accountId || '').trim();
    const amount = toFiniteAmount(body.amount);
    const vendorId = String(body.vendor_id || body.vendorId || '').trim();
    const referenceNumber = String(body.reference_number || body.referenceNumber || '').trim();
    const description = String(body.description || body.notes || '').trim();
    const locationId = String(body.location_id || body.locationId || '').trim();

    if (!DATE_RE.test(date)) throw new Error('Expense date must use YYYY-MM-DD format.');
    if (!accountId) throw new Error('Expense account is required.');
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Amount must be greater than zero.');

    const payload = {
        date,
        account_id: accountId,
        amount: Number(amount.toFixed(2)),
    };

    if (vendorId) payload.vendor_id = vendorId;
    if (referenceNumber) payload.reference_number = referenceNumber;
    if (description) payload.description = description;
    if (locationId) payload.location_id = locationId;

    return payload;
}

export const postZohoExpense = async (req, res) => {
    try {
        const payload = buildExpensePayload(req.body || {});
        const data = await createExpense(payload);

        return res.status(201).json({
            success: true,
            data,
            message: 'Expense has been created in Zoho Books.',
        });
    } catch (error) {
        console.error('[ZohoExpenseCreate] Failed:', error?.message || error);
        const message = error?.message || 'Failed to create expense in Zoho Books';
        const isValidationError = /required|YYYY-MM-DD|greater than|must use/i.test(message);
        return res.status(isValidationError ? 400 : mapZohoErrorStatus(message)).json({
            success: false,
            message,
        });
    }
};
