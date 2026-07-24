import axios from 'axios';
import ZohoExpense from '../models/ZohoExpense.js';
import {
    createExpense,
    fetchLocations,
    getZohoOrganizationId,
    uploadExpenseAttachment,
} from '../services/zohoService.js';
import { mapZohoExpenseToDoc } from './zohoPurchaseMappers.js';
import { withZohoOrganization } from './zohoOrgContext.js';
import { resolveZohoOrganizationIdForRewardEmployee } from './syncRewardPaymentToZoho.js';
import { downloadS3ObjectBytes } from './s3Upload.js';

const DEFAULT_LOCATION_NAME = 'Head Office';
/** Zoho UAE UI label "Non VAT" → API `vat_not_registered`. */
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
    let filename = String(name || '').trim() || 'loan-attachment.pdf';
    if (/\.(pdf|png|jpe?g|gif|bmp|xls|xlsx|doc|docx|txt|csv)$/i.test(filename)) {
        return filename.slice(0, 200);
    }
    const stem = filename.replace(/\.[^.]+$/, '').trim() || 'loan-attachment';
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
            console.warn('[LoanZohoExpense] S3 download failed:', err?.message || err);
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
            console.warn('[LoanZohoExpense] URL download failed:', err?.message || err);
        }
    }

    if (!buffer?.length && attachment?.url && !/^https?:\/\//i.test(String(attachment.url))) {
        try {
            buffer = await downloadS3ObjectBytes(String(attachment.url));
        } catch {
            /* ignore */
        }
    }

    if (!buffer?.length) return null;

    return {
        buffer,
        filename: ensureZohoSafeFilename(nameHint || 'loan-attachment.pdf', mimeType),
        mimeType: mimeType || 'application/pdf',
    };
}

/**
 * Prefer the loan/advance application attachment (Zoho "Upload your Files"),
 * then payment receipt, then supporting / acknowledgment PDFs.
 */
function collectLoanAttachmentCandidates(loan, payment) {
    const list = [];
    const push = (att) => {
        if (!att || typeof att !== 'object') return;
        if (!att.url && !att.publicId && !att.data) return;
        list.push(att);
    };

    push(loan?.attachment);
    push(payment?.attachment);
    const approvals = Array.isArray(loan?.approvalAttachments) ? loan.approvalAttachments : [];
    for (const att of approvals.filter((a) => a?.source !== 'acknowledgment')) push(att);
    for (const att of approvals.filter((a) => a?.source === 'acknowledgment')) push(att);
    return list;
}

async function resolveHeadOfficeLocationId() {
    const wanted = clean(
        process.env.ZOHO_LOAN_EXPENSE_LOCATION_NAME || DEFAULT_LOCATION_NAME,
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

/**
 * When Accounts marks loan/advance Paid → Zoho Books Expense matching Add Expense form:
 * Location Head Office · Tax Exclusive · Tax Treatment Non VAT ·
 * Reference# + Notes = loan description · Attachment = loan/advance file.
 */
export async function syncLoanPaymentToZohoExpense({
    payment,
    loan,
    employee,
    organizationId = '',
    expenseAccountId = '',
    expenseAccountName = '',
    paidThroughAccountId = '',
    paidThroughAccountName = '',
} = {}) {
    const typeLabel = loan?.type === 'Advance' ? 'Advance' : 'Loan';
    const amount = money(payment?.amount ?? loan?.amount);
    const debitId = clean(expenseAccountId || loan?.expenseAccountId);
    const creditId = clean(paidThroughAccountId || loan?.paidThroughAccountId);

    if (!loan?._id) return { ok: false, message: 'Loan is required.' };
    if (amount <= 0) return { ok: false, message: 'Payment amount is required for Zoho Expense.' };
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

    if (clean(loan.zohoExpenseId)) {
        return {
            ok: true,
            skipped: true,
            expenseId: clean(loan.zohoExpenseId),
            organizationId: clean(loan.zohoOrganizationId) || getZohoOrganizationId(),
            message: 'Zoho Expense already exists for this loan/advance.',
        };
    }

    const orgId =
        clean(organizationId) ||
        clean(loan.zohoOrganizationId) ||
        (await resolveZohoOrganizationIdForRewardEmployee(employee || loan?.employeeId));

    const date =
        toDateKey(loan.appliedDate) ||
        toDateKey(loan.createdAt) ||
        toDateKey(payment?.paymentDate) ||
        new Date().toISOString().slice(0, 10);

    // Same text for Zoho Reference# and Notes (loan/advance description).
    const description = clean(
        loan.reason ||
            loan.description ||
            payment?.notes ||
            `${typeLabel} ${clean(loan.loanId)} · ${clean(loan.employeeId)}`,
    ).slice(0, 500);

    const referenceNumber = description.slice(0, 100);

    try {
        const result = await withZohoOrganization(orgId, async () => {
            const { locationId, locationName } = await resolveHeadOfficeLocationId();
            if (!locationId) {
                throw new Error(
                    `Zoho location "${DEFAULT_LOCATION_NAME}" was not found. Check Locations in Zoho Books.`,
                );
            }

            const taxTreatment = clean(
                process.env.ZOHO_LOAN_EXPENSE_TAX_TREATMENT || DEFAULT_TAX_TREATMENT,
            );
            const placeOfSupply = clean(
                process.env.ZOHO_LOAN_EXPENSE_PLACE_OF_SUPPLY || DEFAULT_PLACE_OF_SUPPLY,
            );

            const payload = {
                date,
                account_id: debitId,
                paid_through_account_id: creditId,
                amount,
                currency_code: DEFAULT_CURRENCY,
                // Amount Is → Tax Exclusive (always)
                is_inclusive_tax: false,
                // Tax Treatment → Non VAT (always)
                tax_treatment: taxTreatment,
                place_of_supply: placeOfSupply,
                // Location → Head Office (always)
                location_id: locationId,
                // Reference# + Notes → loan/advance description
                reference_number: referenceNumber,
                description,
            };

            const expense = await createExpense(payload);
            const expenseId = clean(
                expense?.expense_id || expense?.expenseId || expense?.id,
            );
            if (!expenseId) {
                throw new Error('Zoho Expense created but expense_id was missing in response.');
            }

            // Soft-fail attachment — expense row still succeeds
            let attachmentResult = { ok: true, skipped: true };
            const candidates = collectLoanAttachmentCandidates(loan, payment);
            for (const candidate of candidates) {
                const file = await resolveAttachmentFile(candidate);
                if (!file) continue;
                try {
                    await uploadExpenseAttachment(expenseId, file);
                    attachmentResult = { ok: true, filename: file.filename };
                    break;
                } catch (attachErr) {
                    attachmentResult = {
                        ok: false,
                        message: attachErr?.message || 'Attachment upload failed',
                    };
                    console.warn('[LoanZohoExpense] Attachment failed:', attachmentResult.message);
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
                    '[LoanZohoExpense] Local ZohoExpense cache upsert failed:',
                    cacheErr?.message || cacheErr,
                );
            }

            return {
                expenseId,
                expenseNumber: clean(expense?.expense_number || expense?.expenseNumber),
                locationId,
                locationName,
                attachment: attachmentResult,
                raw: expense,
            };
        });

        return {
            ok: true,
            expenseId: result.expenseId,
            expenseNumber: result.expenseNumber,
            organizationId: orgId,
            locationId: result.locationId,
            locationName: result.locationName,
            attachment: result.attachment,
            message: result.attachment?.ok === false
                ? `Zoho Expense created; attachment not uploaded: ${result.attachment.message}`
                : 'Zoho Expense created.',
        };
    } catch (err) {
        let message = err?.message || 'Failed to create Zoho Expense for loan/advance';
        if (/valid expense account/i.test(message)) {
            message =
                'Please enter a valid expense account. Expense Account must be a Zoho Expense / P&L account — not Cash, Bank, or Petty Cash. Use Cash/Bank only in Paid Through.';
        }
        console.error('[LoanZohoExpense]', message);
        return { ok: false, message, organizationId: orgId };
    }
}
