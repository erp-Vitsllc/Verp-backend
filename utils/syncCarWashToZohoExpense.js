import ZohoExpense from '../models/ZohoExpense.js';
import {
    createExpense,
    fetchLocations,
    getZohoOrganizationId,
    uploadExpenseAttachment,
} from '../services/zohoService.js';
import { mapZohoExpenseToDoc } from './zohoPurchaseMappers.js';
import { withZohoOrganization } from './zohoOrgContext.js';
import { downloadS3ObjectBytes } from './s3Upload.js';
import axios from 'axios';

const DEFAULT_LOCATION_NAME = 'Head Office';
const DEFAULT_TAX_TREATMENT = 'vat_not_registered';
const DEFAULT_PLACE_OF_SUPPLY = 'DU';
const DEFAULT_CURRENCY = 'AED';

function clean(value, fallback = '') {
    const text = String(value ?? '').trim();
    return text || fallback;
}

function money(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function toDateKey(value) {
    if (!value) return '';
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.toISOString().slice(0, 10);
    }
    const raw = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return '';
}

function ensureZohoSafeFilename(name, mimeType) {
    let filename = String(name || '').trim() || 'car-wash-invoice.pdf';
    if (/\.(pdf|png|jpe?g|gif|bmp|xls|xlsx|doc|docx|txt|csv)$/i.test(filename)) {
        return filename.slice(0, 200);
    }
    const stem = filename.replace(/\.[^.]+$/, '').trim() || 'car-wash-invoice';
    const ext =
        /png/i.test(mimeType)
            ? 'png'
            : /jpe?g/i.test(mimeType)
              ? 'jpg'
              : /gif/i.test(mimeType)
                ? 'gif'
                : /bmp/i.test(mimeType)
                  ? 'bmp'
                  : 'pdf';
    return `${stem}.${ext}`.slice(0, 200);
}

function bufferFromBase64(data) {
    const raw = String(data || '').trim();
    if (!raw) return null;
    let base64 = raw;
    let mimeType = '';
    const dataMatch = raw.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/is);
    if (dataMatch) {
        if (dataMatch[1]) mimeType = String(dataMatch[1]).trim();
        base64 = dataMatch[2];
    } else if (raw.includes(',')) {
        base64 = raw.split(',').pop();
    }
    try {
        const buffer = Buffer.from(String(base64 || '').replace(/\s/g, ''), 'base64');
        if (!buffer.length) return null;
        return { buffer, mimeType };
    } catch {
        return null;
    }
}

async function resolveAttachmentFile(attachment = {}) {
    if (!attachment || typeof attachment !== 'object') return null;

    const mimeHint = String(attachment?.mimeType || attachment?.mime || '').trim();
    const nameHint = String(attachment?.name || '').trim();
    let buffer = null;
    let mimeType = mimeHint;

    const s3Key = String(attachment?.publicId || '').trim();
    if (s3Key) {
        try {
            buffer = await downloadS3ObjectBytes(s3Key);
        } catch (err) {
            console.warn('[CarWashZohoExpense] S3 download failed:', err?.message || err);
        }
    }

    if (!buffer?.length && attachment?.data) {
        const parsed = bufferFromBase64(attachment.data);
        if (parsed?.buffer?.length) {
            buffer = parsed.buffer;
            if (!mimeType && parsed.mimeType) mimeType = parsed.mimeType;
        }
    }

    if (!buffer?.length && attachment?.url && /^https?:\/\//i.test(String(attachment.url))) {
        try {
            const response = await axios.get(String(attachment.url), {
                responseType: 'arraybuffer',
                timeout: 60000,
                maxContentLength: 25 * 1024 * 1024,
            });
            buffer = Buffer.from(response.data);
            if (!mimeType && response.headers?.['content-type']) {
                mimeType = String(response.headers['content-type']).split(';')[0].trim();
            }
        } catch (err) {
            console.warn('[CarWashZohoExpense] URL download failed:', err?.message || err);
        }
    }

    if (!buffer?.length) return null;

    return {
        buffer,
        filename: ensureZohoSafeFilename(nameHint || 'car-wash-invoice.pdf', mimeType),
        mimeType: mimeType || 'application/pdf',
    };
}

async function resolveHeadOfficeLocationId() {
    const wanted = clean(
        process.env.ZOHO_CAR_WASH_EXPENSE_LOCATION_NAME || DEFAULT_LOCATION_NAME,
    ).toLowerCase();
    const locations = await fetchLocations();
    const rows = Array.isArray(locations) ? locations : [];

    const match =
        rows.find((l) =>
            clean(l?.location_name || l?.name)
                .toLowerCase()
                .includes(wanted),
        ) ||
        rows.find((l) => /head\s*office/i.test(clean(l?.location_name || l?.name))) ||
        rows.find((l) => l?.is_primary || l?.isPrimary) ||
        rows[0];

    return {
        locationId: clean(match?.location_id || match?.locationId || match?.id),
        locationName: clean(match?.location_name || match?.name, DEFAULT_LOCATION_NAME),
    };
}

function buildCarWashExpenseName({ asset, remark = {}, service } = {}) {
    const plate = [asset?.plateEmirate, asset?.plateNumber].filter(Boolean).join(' ').trim();
    const assetId = clean(asset?.assetId);
    const month = clean(remark.carWashMonth);
    const type = clean(remark.carWashType || 'Car Wash');
    const parts = ['Car Wash', assetId || plate, month, type].filter(Boolean);
    return parts.join(' · ').slice(0, 100);
}

/**
 * Car Wash only → Zoho Books Expense (NOT Bill).
 * Same core fields as Accounts → Expenses → Add Expense:
 * Expense Account, Amount, Paid Through, Name/Notes (auto).
 */
export async function syncCarWashToZohoExpense({
    asset,
    service,
    expenseAccountId = '',
    expenseAccountName = '',
    paidThroughAccountId = '',
    paidThroughAccountName = '',
    expenseName = '',
    organizationId = '',
} = {}) {
    if (!service) return { ok: false, message: 'Car wash service record is required.' };

    let remark = {};
    try {
        remark = service.remark
            ? typeof service.remark === 'object'
                ? service.remark
                : JSON.parse(service.remark)
            : {};
    } catch {
        remark = {};
    }

    const amount = money(service.value ?? remark.garageBillAmount ?? remark.billingTotalAmount);
    const debitId = clean(expenseAccountId || remark.expenseAccountId);
    const creditId = clean(paidThroughAccountId || remark.paidThroughAccountId);
    const existingExpenseId = clean(remark.zohoExpenseId);

    if (amount <= 0) {
        return { ok: false, message: 'A valid amount is required before creating the Zoho Expense.' };
    }
    if (!debitId || !creditId) {
        return {
            ok: false,
            message: 'Expense Account and Paid Through are required for Zoho Expense.',
        };
    }
    if (debitId === creditId) {
        return {
            ok: false,
            message: 'Expense Account and Paid Through must be different accounts.',
        };
    }

    if (existingExpenseId) {
        return {
            ok: true,
            skipped: true,
            expenseId: existingExpenseId,
            organizationId: clean(remark.zohoOrganizationId) || getZohoOrganizationId(),
            message: 'Zoho Expense already exists for this car wash.',
        };
    }

    const orgId = clean(organizationId) || clean(remark.zohoOrganizationId) || getZohoOrganizationId();
    const autoName = clean(expenseName || remark.zohoExpenseName || buildCarWashExpenseName({ asset, remark, service }));
    const date =
        toDateKey(remark.carWashServiceDate) ||
        toDateKey(service.date) ||
        new Date().toISOString().slice(0, 10);

    try {
        const result = await withZohoOrganization(orgId, async () => {
            const { locationId, locationName } = await resolveHeadOfficeLocationId();
            if (!locationId) {
                throw new Error(
                    `Zoho location "${DEFAULT_LOCATION_NAME}" was not found. Check Locations in Zoho Books.`,
                );
            }

            const taxTreatment = clean(
                process.env.ZOHO_CAR_WASH_EXPENSE_TAX_TREATMENT || DEFAULT_TAX_TREATMENT,
            );
            const placeOfSupply = clean(
                process.env.ZOHO_CAR_WASH_EXPENSE_PLACE_OF_SUPPLY || DEFAULT_PLACE_OF_SUPPLY,
            );

            const payload = {
                date,
                account_id: debitId,
                paid_through_account_id: creditId,
                amount,
                currency_code: DEFAULT_CURRENCY,
                is_inclusive_tax: false,
                tax_treatment: taxTreatment,
                place_of_supply: placeOfSupply,
                location_id: locationId,
                reference_number: autoName.slice(0, 100),
                description: autoName.slice(0, 100),
            };

            const expense = await createExpense(payload);
            const expenseId = clean(expense?.expense_id || expense?.expenseId || expense?.id);
            if (!expenseId) {
                throw new Error('Zoho Expense created but expense_id was missing in response.');
            }

            // Soft-fail invoice attachment when present on the car wash request.
            let attachmentResult = { ok: true, skipped: true };
            const invoice =
                remark.invoiceFile ||
                remark.invoice ||
                (remark.invoiceUrl || remark.invoicePublicId
                    ? {
                          url: remark.invoiceUrl,
                          publicId: remark.invoicePublicId,
                          name: remark.invoiceName || 'car-wash-invoice.pdf',
                          mimeType: remark.invoiceMime || '',
                      }
                    : null);
            if (invoice) {
                try {
                    const file = await resolveAttachmentFile(invoice);
                    if (file) {
                        await uploadExpenseAttachment(expenseId, file);
                        attachmentResult = { ok: true, filename: file.filename };
                    }
                } catch (attachErr) {
                    attachmentResult = {
                        ok: false,
                        message: attachErr?.message || 'Invoice attachment upload failed',
                    };
                    console.warn('[CarWashZohoExpense] Attachment failed:', attachErr?.message || attachErr);
                }
            }

            try {
                const doc = mapZohoExpenseToDoc(expense, orgId, new Date());
                if (doc?.zohoExpenseId) {
                    await ZohoExpense.findOneAndUpdate(
                        { organizationId: orgId, zohoExpenseId: doc.zohoExpenseId },
                        { $set: doc },
                        { upsert: true, new: true },
                    );
                }
            } catch (cacheErr) {
                console.warn(
                    '[CarWashZohoExpense] Local ZohoExpense cache upsert failed:',
                    cacheErr?.message || cacheErr,
                );
            }

            return {
                expenseId,
                expenseNumber: clean(expense?.expense_number || expense?.expenseNumber),
                locationId,
                locationName,
                attachment: attachmentResult,
                expenseName: autoName,
                expenseAccountId: debitId,
                expenseAccountName: clean(expenseAccountName || remark.expenseAccountName),
                paidThroughAccountId: creditId,
                paidThroughAccountName: clean(paidThroughAccountName || remark.paidThroughAccountName),
                raw: expense,
            };
        });

        return {
            ok: true,
            expenseId: result.expenseId,
            expenseNumber: result.expenseNumber,
            organizationId: orgId,
            expenseName: result.expenseName,
            expenseAccountId: result.expenseAccountId,
            expenseAccountName: result.expenseAccountName,
            paidThroughAccountId: result.paidThroughAccountId,
            paidThroughAccountName: result.paidThroughAccountName,
            locationId: result.locationId,
            locationName: result.locationName,
            attachment: result.attachment,
            message:
                result.attachment?.ok === false
                    ? `Zoho Expense created; invoice not attached: ${result.attachment.message}`
                    : 'Zoho Expense created.',
        };
    } catch (err) {
        let message = err?.message || 'Failed to create Zoho Expense for car wash';
        if (/valid expense account/i.test(message)) {
            message =
                'Please enter a valid expense account. Expense Account must be a Zoho Expense / P&L account — not Cash, Bank, or Petty Cash. Use Cash/Bank only in Paid Through.';
        }
        console.error('[CarWashZohoExpense]', message);
        return { ok: false, message, organizationId: orgId };
    }
}

export { buildCarWashExpenseName };
