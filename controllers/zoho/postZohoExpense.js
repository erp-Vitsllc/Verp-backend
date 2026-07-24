import { createExpense } from '../../services/zohoService.js';
import { mapZohoErrorStatus, toFiniteAmount } from './zohoVendorPaymentUtils.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toBoolean(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    const raw = String(value ?? '').trim().toLowerCase();
    if (!raw) return fallback;
    if (['1', 'true', 'yes', 'inclusive'].includes(raw)) return true;
    if (['0', 'false', 'no', 'exclusive'].includes(raw)) return false;
    return fallback;
}

function cleanTags(rawTags) {
    if (!Array.isArray(rawTags)) return [];
    return rawTags
        .map((tag) => {
            const tagId = String(tag?.tag_id || tag?.tagId || '').trim();
            const tagOptionId = String(
                tag?.tag_option_id || tag?.tagOptionId || tag?.option_id || '',
            ).trim();
            if (!tagId || !tagOptionId || tagOptionId === 'untagged') return null;
            return { tag_id: tagId, tag_option_id: tagOptionId };
        })
        .filter(Boolean);
}

function cleanLineItems(rawLines) {
    if (!Array.isArray(rawLines)) return [];
    return rawLines
        .map((line, index) => {
            const accountId = String(line?.account_id || line?.accountId || '').trim();
            const amount = toFiniteAmount(line?.amount);
            if (!accountId || !Number.isFinite(amount) || amount <= 0) return null;

            const item = {
                account_id: accountId,
                amount: Number(amount.toFixed(2)),
                item_order: index + 1,
            };

            const description = String(line?.description || line?.notes || '').trim();
            const taxId = String(line?.tax_id || line?.taxId || '').trim();
            const tags = cleanTags(line?.tags);
            if (description) item.description = description.slice(0, 500);
            if (taxId) item.tax_id = taxId;
            if (tags.length) item.tags = tags;
            return item;
        })
        .filter(Boolean);
}

function buildExpensePayload(body = {}) {
    const date = String(body.date || '').trim();
    const paidThroughAccountId = String(
        body.paid_through_account_id || body.paidThroughAccountId || '',
    ).trim();
    const vendorId = String(body.vendor_id || body.vendorId || '').trim();
    const referenceNumber = String(body.reference_number || body.referenceNumber || '').trim();
    const description = String(body.description || body.notes || '').trim();
    const locationId = String(body.location_id || body.locationId || '').trim();
    const customerId = String(body.customer_id || body.customerId || '').trim();
    const taxId = String(body.tax_id || body.taxId || '').trim();
    const taxTreatment = String(body.tax_treatment || body.taxTreatment || '').trim();
    const placeOfSupply = String(body.place_of_supply || body.placeOfSupply || '').trim();
    const isInclusiveTax = toBoolean(body.is_inclusive_tax ?? body.isInclusiveTax, false);
    const currencyCode = String(body.currency_code || body.currencyCode || '').trim();
    const tags = cleanTags(body.tags);
    const lineItems = cleanLineItems(body.line_items || body.lineItems);

    let accountId = String(body.account_id || body.accountId || '').trim();
    let amount = toFiniteAmount(body.amount);

    if (lineItems.length) {
        amount = Number(
            lineItems.reduce((sum, line) => sum + Number(line.amount || 0), 0).toFixed(2),
        );
        if (!accountId) accountId = lineItems[0].account_id;
    }

    if (!DATE_RE.test(date)) throw new Error('Expense date must use YYYY-MM-DD format.');
    if (!paidThroughAccountId) throw new Error('Paid Through account is required.');
    if (!taxTreatment) throw new Error('Tax Treatment is required.');
    if (!placeOfSupply) throw new Error('Place of Supply is required.');

    if (lineItems.length) {
        if (!Number.isFinite(amount) || amount <= 0) {
            throw new Error('Add at least one itemized line with an amount greater than zero.');
        }
    } else {
        if (!accountId) throw new Error('Expense account is required.');
        if (!Number.isFinite(amount) || amount <= 0) {
            throw new Error('Amount must be greater than zero.');
        }
    }

    const payload = {
        date,
        account_id: accountId,
        paid_through_account_id: paidThroughAccountId,
        amount: Number(amount.toFixed(2)),
        is_inclusive_tax: isInclusiveTax,
        tax_treatment: taxTreatment,
        place_of_supply: placeOfSupply,
    };

    if (lineItems.length) payload.line_items = lineItems;
    if (vendorId) payload.vendor_id = vendorId;
    if (referenceNumber) payload.reference_number = referenceNumber;
    if (description) payload.description = description.slice(0, 500);
    if (locationId) payload.location_id = locationId;
    if (customerId) payload.customer_id = customerId;
    if (taxId) payload.tax_id = taxId;
    if (currencyCode) payload.currency_code = currencyCode;
    if (tags.length) payload.tags = tags;

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
        const isValidationError =
            /required|YYYY-MM-DD|greater than|must use|itemized|at least one/i.test(message) ||
            Number(error?.response?.status) === 400;
        return res.status(isValidationError ? 400 : mapZohoErrorStatus(message)).json({
            success: false,
            message,
        });
    }
};
