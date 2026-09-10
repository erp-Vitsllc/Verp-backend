import {
    createVendorCredit,
    markVendorCreditOpen,
    uploadVendorCreditAttachment,
} from '../../services/zohoService.js';
import { mapZohoErrorStatus, toFiniteAmount } from './zohoVendorPaymentUtils.js';
import { resolveZohoAttachmentUpload } from '../../utils/resolveZohoAttachmentUpload.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDraftStatus(value) {
    return /draft/i.test(String(value || ''));
}

function vendorCreditIdOf(doc) {
    return String(doc?.vendor_credit_id || doc?.vendorcredit_id || doc?.id || '').trim();
}

async function parseVendorCreditAttachment(raw) {
    return resolveZohoAttachmentUpload(raw, 'vendor-credit-attachment.pdf');
}

function cleanLineItems(lineItems) {
    if (!Array.isArray(lineItems)) return [];

    return lineItems
        .map((item) => {
            const accountId = String(item?.account_id || item?.accountId || '').trim();
            const description = String(item?.description || item?.name || '').trim();
            const name = String(item?.name || item?.item_name || description || '').trim();
            const quantity = toFiniteAmount(item?.quantity);
            const rate = toFiniteAmount(item?.rate);
            const taxId = String(item?.tax_id || item?.taxId || '').trim();

            if (!accountId) return null;
            if (!Number.isFinite(quantity) || quantity <= 0) return null;
            if (!Number.isFinite(rate) || rate < 0) return null;

            const row = {
                account_id: accountId,
                quantity: Number(quantity.toFixed(4)),
                rate: Number(rate.toFixed(2)),
            };

            if (name) row.name = name;
            if (description) row.description = description;
            if (taxId) row.tax_id = taxId;
            return row;
        })
        .filter(Boolean);
}

export function buildVendorCreditPayload(body = {}) {
    const vendorId = String(body.vendor_id || body.vendorId || '').trim();
    const date = String(body.date || '').trim();
    const locationId = String(body.location_id || body.locationId || '').trim();
    const referenceNumber = String(
        body.reference_number || body.referenceNumber || body.orderNumber || '',
    ).trim();
    const notes = String(body.notes || body.description || '').trim();
    const creditNumber = String(
        body.vendor_credit_number || body.vendorCreditNumber || body.creditNoteNumber || '',
    ).trim();
    const taxTreatment = String(body.tax_treatment || body.taxTreatment || '').trim();
    const taxId = String(body.tax_id || body.taxId || '').trim();
    const placeOfSupply = String(
        body.place_of_supply || body.placeOfSupply || body.destination_of_supply || '',
    ).trim();

    if (!vendorId) throw new Error('Vendor is required.');
    if (!DATE_RE.test(date)) throw new Error('Vendor credit date must use YYYY-MM-DD format.');

    const lineItems = cleanLineItems(body.line_items || body.lineItems);
    if (!lineItems.length) {
        throw new Error('Add at least one line with account, quantity, and rate.');
    }

    const payload = {
        vendor_id: vendorId,
        date,
        line_items: lineItems,
    };

    if (locationId) payload.location_id = locationId;
    if (referenceNumber) payload.reference_number = referenceNumber;
    if (notes) payload.notes = notes;
    if (creditNumber) payload.vendor_credit_number = creditNumber;
    if (taxTreatment) payload.tax_treatment = taxTreatment;
    if (taxId) payload.tax_id = taxId;
    if (placeOfSupply) payload.place_of_supply = placeOfSupply;

    if (body.is_inclusive_tax === true || body.isInclusiveTax === true) {
        payload.is_inclusive_tax = true;
    } else if (body.is_inclusive_tax === false || body.isInclusiveTax === false) {
        payload.is_inclusive_tax = false;
    }

    const discountAmount = toFiniteAmount(body.discount);
    if (Number.isFinite(discountAmount) && discountAmount > 0) {
        payload.discount = Number(discountAmount.toFixed(2));
        payload.discount_type = 'entity_level';
        payload.is_discount_before_tax = true;
    }

    return payload;
}

export async function createOpenZohoVendorCredit(body = {}) {
    const payload = buildVendorCreditPayload(body);
    const creditNumber = String(payload.vendor_credit_number || '').trim();
    const params = creditNumber ? { ignore_auto_number_generation: 'true' } : {};

    let created = await createVendorCredit(payload, params);
    const creditId = vendorCreditIdOf(created);
    if (!creditId) {
        throw new Error('Zoho created the vendor credit but did not return an id.');
    }

    const status = String(created?.status || created?.vendor_credit_status || '').trim();
    if (isDraftStatus(status) || !status) {
        try {
            created = (await markVendorCreditOpen(creditId)) || created;
        } catch (err) {
            const message = String(err?.message || '');
            if (!/already|open|approved/i.test(message)) {
                throw err;
            }
        }
    }

    let attachment = { ok: true, skipped: true };
    const file = await parseVendorCreditAttachment(body.attachment);
    if (file) {
        try {
            await uploadVendorCreditAttachment(creditId, file);
            attachment = { ok: true, filename: file.filename };
        } catch (err) {
            attachment = {
                ok: false,
                message: err?.message || 'Failed to upload attachment to Zoho vendor credit.',
            };
        }
    }

    return {
        vendorCredit: created,
        vendorCreditId: creditId,
        vendorCreditNumber: String(
            created?.vendor_credit_number || created?.creditnote_number || creditNumber || '',
        ).trim(),
        status: String(created?.status || 'open').trim() || 'open',
        total: Number(created?.total ?? created?.bcy_total ?? 0) || 0,
        attachment,
    };
}

export const postZohoVendorCredit = async (req, res) => {
    try {
        const result = await createOpenZohoVendorCredit(req.body || {});
        const attachWarning =
            result.attachment?.ok === false
                ? ` Attachment was not uploaded: ${result.attachment.message}`
                : '';
        return res.status(201).json({
            success: true,
            data: result.vendorCredit,
            vendorCreditId: result.vendorCreditId,
            vendorCreditNumber: result.vendorCreditNumber,
            status: result.status,
            attachment: result.attachment,
            message: `Vendor credit ${result.vendorCreditNumber || result.vendorCreditId} created in Zoho as Open.${attachWarning}`,
        });
    } catch (error) {
        console.error('[ZohoVendorCreditCreate] Failed:', error?.message || error);
        const message = error?.message || 'Failed to create vendor credit in Zoho Books';
        const isValidationError =
            /required|YYYY-MM-DD|at least one|must use/i.test(message);

        return res.status(isValidationError ? 400 : mapZohoErrorStatus(message)).json({
            success: false,
            message,
        });
    }
};
