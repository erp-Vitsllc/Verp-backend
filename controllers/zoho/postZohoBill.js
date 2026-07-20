import { createBill, updateBill } from '../../services/zohoService.js';
import { upsertZohoBillFromApi } from '../../services/zohoPurchaseSyncService.js';
import { mapZohoErrorStatus, toFiniteAmount } from './zohoVendorPaymentUtils.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cleanLineItems(lineItems) {
    if (!Array.isArray(lineItems)) return [];

    return lineItems
        .map((item) => {
            const accountId = String(item?.account_id || item?.accountId || '').trim();
            const description = String(item?.description || '').trim();
            const quantity = toFiniteAmount(item?.quantity);
            const rate = toFiniteAmount(item?.rate);
            const lineItemId = String(item?.line_item_id || item?.lineItemId || '').trim();

            if (!accountId) return null;
            if (!Number.isFinite(quantity) || quantity <= 0) return null;
            if (!Number.isFinite(rate) || rate < 0) return null;

            const row = {
                account_id: accountId,
                quantity: Number(quantity.toFixed(4)),
                rate: Number(rate.toFixed(2)),
            };

            if (description) row.description = description;
            if (lineItemId) row.line_item_id = lineItemId;
            return row;
        })
        .filter(Boolean);
}

function buildBillPayload(body = {}) {
    const vendorId = String(body.vendor_id || body.vendorId || '').trim();
    const billNumber = String(body.bill_number || body.billNumber || '').trim();
    const date = String(body.date || '').trim();
    const dueDate = String(body.due_date || body.dueDate || '').trim();
    const referenceNumber = String(body.reference_number || body.referenceNumber || '').trim();
    const notes = String(body.notes || body.description || '').trim();
    const locationId = String(body.location_id || body.locationId || '').trim();

    if (!vendorId) throw new Error('Vendor is required.');
    if (!billNumber) throw new Error('Bill number is required.');
    if (!DATE_RE.test(date)) throw new Error('Bill date must use YYYY-MM-DD format.');
    if (dueDate && !DATE_RE.test(dueDate)) throw new Error('Due date must use YYYY-MM-DD format.');

    const lineItems = cleanLineItems(body.line_items || body.lineItems);
    if (!lineItems.length) {
        throw new Error('Add at least one bill line with account, quantity, and rate.');
    }

    const payload = {
        vendor_id: vendorId,
        bill_number: billNumber,
        date,
        line_items: lineItems,
    };

    if (dueDate) payload.due_date = dueDate;
    if (referenceNumber) payload.reference_number = referenceNumber;
    if (notes) payload.notes = notes;
    if (locationId) payload.location_id = locationId;

    const paymentTerms = Number(body.payment_terms ?? body.paymentTerms);
    if (Number.isFinite(paymentTerms)) payload.payment_terms = paymentTerms;

    const paymentTermsLabel = String(
        body.payment_terms_label || body.paymentTermsLabel || '',
    ).trim();
    if (paymentTermsLabel) payload.payment_terms_label = paymentTermsLabel;

    return payload;
}

export const postZohoBill = async (req, res) => {
    try {
        const payload = buildBillPayload(req.body || {});
        const data = await createBill(payload);

        try {
            await upsertZohoBillFromApi(data);
        } catch (syncError) {
            console.warn(
                '[ZohoBillCreate] Zoho create ok; local DB upsert failed:',
                syncError?.message || syncError,
            );
        }

        return res.status(201).json({
            success: true,
            data,
            message: 'Bill has been created in Zoho Books.',
        });
    } catch (error) {
        console.error('[ZohoBillCreate] Failed:', error?.message || error);

        const message = error?.message || 'Failed to create bill in Zoho Books';
        const isValidationError =
            /required|YYYY-MM-DD|at least one|greater than|must use/i.test(message);

        return res.status(isValidationError ? 400 : mapZohoErrorStatus(message)).json({
            success: false,
            message,
        });
    }
};

export const putZohoBill = async (req, res) => {
    try {
        const billId = String(req.params?.billId || '').trim();
        if (!billId) {
            return res.status(400).json({ success: false, message: 'Bill id is required.' });
        }

        const payload = buildBillPayload(req.body || {});
        const data = await updateBill(billId, payload);

        try {
            await upsertZohoBillFromApi(data);
        } catch (syncError) {
            console.warn(
                '[ZohoBillUpdate] Zoho update ok; local DB upsert failed:',
                syncError?.message || syncError,
            );
        }

        return res.status(200).json({
            success: true,
            data,
            message: 'Bill has been updated in Zoho Books.',
        });
    } catch (error) {
        console.error('[ZohoBillUpdate] Failed:', error?.message || error);

        const message = error?.message || 'Failed to update bill in Zoho Books';
        const isValidationError =
            /required|YYYY-MM-DD|at least one|greater than|must use/i.test(message);

        return res.status(isValidationError ? 400 : mapZohoErrorStatus(message)).json({
            success: false,
            message,
        });
    }
};
