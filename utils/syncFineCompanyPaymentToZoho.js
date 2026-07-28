import {
    createBankTransaction,
    fetchLocations,
    getZohoOrganizationId,
    uploadBankTransactionAttachment,
} from '../services/zohoService.js';
import { withZohoOrganization } from './zohoOrgContext.js';
import { resolveZohoOrganizationIdForRewardEmployee } from './syncRewardPaymentToZoho.js';

const DEFAULT_LOCATION_NAME = 'Head Office';
const DEFAULT_TAX_TREATMENT = 'vat_not_registered';
const DEFAULT_PLACE_OF_SUPPLY = 'DU';
const DEFAULT_CURRENCY = 'AED';
/** Zoho Banking → Money In → Expense Refund (not Payment Refund). */
const FINE_COMPANY_TRANSACTION_TYPE = 'expense_refund';
const FINE_COMPANY_LABEL = 'Expense Refund';

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

function resolveAttachmentCandidates(payment, attachments = []) {
    const list = [];
    const push = (att) => {
        if (!att || typeof att !== 'object') return;
        if (!att.data && !att.url) return;
        list.push(att);
    };
    (Array.isArray(attachments) ? attachments : []).forEach(push);
    push(payment?.attachment);
    return list;
}

async function resolveHeadOfficeLocationId(preferredLocationId = '') {
    const preferred = clean(preferredLocationId);
    const locations = await fetchLocations();
    const rows = Array.isArray(locations) ? locations : [];

    if (preferred) {
        const byId = rows.find(
            (l) => clean(l?.location_id || l?.locationId || l?.id) === preferred,
        );
        if (byId) {
            return {
                locationId: preferred,
                locationName: clean(byId?.location_name || byId?.name, DEFAULT_LOCATION_NAME),
            };
        }
    }

    const wanted = clean(
        process.env.ZOHO_LOAN_EXPENSE_LOCATION_NAME || DEFAULT_LOCATION_NAME,
    ).toLowerCase();

    const match =
        rows.find((l) =>
            clean(l?.location_name || l?.name)
                .toLowerCase()
                .includes(wanted),
        ) ||
        rows.find((l) => /head\s*office|vega\s*dxb/i.test(clean(l?.location_name || l?.name))) ||
        rows.find((l) => l?.is_primary || l?.isPrimary) ||
        rows[0];

    return {
        locationId: clean(match?.location_id || match?.locationId || match?.id),
        locationName: clean(match?.location_name || match?.name, DEFAULT_LOCATION_NAME),
    };
}

/**
 * Employee/company recovery → Zoho Books Banking Expense Refund (Money In):
 * to_account = Bank · from_account = From Account (expense) ·
 * transaction_type = expense_refund · optional vendor + attachments.
 *
 * Used for Fine company share and Utility Bill difference recovery.
 */
export async function syncExpenseRefundPaymentToZoho({
    payment,
    employee,
    referenceLabel = '',
    organizationHint = '',
    requireEntityId = true,
    entityId = '',
    expenseAccountId = '',
    expenseAccountName = '',
    paidThroughAccountId = '',
    paidThroughAccountName = '',
    locationId = '',
    taxTreatment = '',
    placeOfSupply = '',
    taxId = '',
    isInclusiveTax = true,
    paymentMode = 'Cash',
    vendorId = '',
    vendorName = '',
    attachments = [],
} = {}) {
    const amount = money(payment?.amount);
    const fromAccountId = clean(expenseAccountId || payment?.expenseAccountId);
    const toAccountId = clean(paidThroughAccountId || payment?.paidThroughAccountId);
    const resolvedVendorId = clean(vendorId);
    const label = clean(referenceLabel, clean(entityId, 'Refund'));

    if (requireEntityId && !clean(entityId)) {
        return { ok: false, message: 'Related entity is required.' };
    }
    if (amount <= 0) {
        return { ok: false, message: 'Payment amount is required for Zoho Expense Refund.' };
    }
    if (!fromAccountId || !toAccountId) {
        return {
            ok: false,
            message: 'Bank and From Account are required for Zoho Expense Refund.',
        };
    }
    if (fromAccountId === toAccountId) {
        return {
            ok: false,
            message: 'Bank and From Account must be different accounts.',
        };
    }

    if (clean(payment?.zohoExpenseId)) {
        return {
            ok: true,
            skipped: true,
            expenseId: clean(payment.zohoExpenseId),
            organizationId: clean(payment.zohoOrganizationId) || getZohoOrganizationId(),
            message: 'Zoho Expense Refund already exists for this payment.',
        };
    }

    const orgId =
        clean(organizationHint) ||
        clean(payment?.zohoOrganizationId) ||
        (await resolveZohoOrganizationIdForRewardEmployee(employee));

    const date =
        toDateKey(payment?.paymentDate) ||
        toDateKey(payment?.createdAt) ||
        new Date().toISOString().slice(0, 10);

    const description = clean(
        payment?.description ||
            `${FINE_COMPANY_LABEL} · ${label} · ${clean(employee?.employeeId || '')}`,
        FINE_COMPANY_LABEL,
    ).slice(0, 500);
    const referenceNumber = clean(
        payment?.remarks?.match(/Ref:\s*([^\s·]+)/i)?.[1] || `${FINE_COMPANY_LABEL}-${label}`,
        label,
    ).slice(0, 100);

    try {
        const result = await withZohoOrganization(orgId, async () => {
            const { locationId: resolvedLocationId, locationName } =
                await resolveHeadOfficeLocationId(locationId);
            if (!resolvedLocationId) {
                throw new Error(
                    `Zoho location was not found. Check Locations in Zoho Books.`,
                );
            }

            const resolvedTaxTreatment = clean(
                taxTreatment ||
                    process.env.ZOHO_LOAN_EXPENSE_TAX_TREATMENT ||
                    DEFAULT_TAX_TREATMENT,
            );
            const resolvedPlaceOfSupply = clean(
                placeOfSupply ||
                    process.env.ZOHO_LOAN_EXPENSE_PLACE_OF_SUPPLY ||
                    DEFAULT_PLACE_OF_SUPPLY,
            );
            const resolvedPaymentMode = clean(paymentMode || 'Cash', 'Cash');
            const resolvedTaxId = clean(taxId);

            const payload = {
                transaction_type: FINE_COMPANY_TRANSACTION_TYPE,
                from_account_id: fromAccountId,
                to_account_id: toAccountId,
                amount,
                currency_code: DEFAULT_CURRENCY,
                payment_mode: resolvedPaymentMode,
                date,
                reference_number: referenceNumber,
                description,
                is_inclusive_tax: Boolean(isInclusiveTax),
                tax_treatment: resolvedTaxTreatment,
                place_of_supply: resolvedPlaceOfSupply,
                location_id: resolvedLocationId,
            };
            if (resolvedTaxId) payload.tax_id = resolvedTaxId;
            // Zoho bank txn accepts customer_id for customer or vendor contact.
            if (resolvedVendorId) {
                payload.customer_id = resolvedVendorId;
                payload.vendor_id = resolvedVendorId;
            }

            const txn = await createBankTransaction(payload);
            const transactionId = clean(
                txn?.transaction_id ||
                    txn?.banktransaction_id ||
                    txn?.bank_transaction_id ||
                    txn?.expense_id ||
                    txn?.id,
            );
            if (!transactionId) {
                throw new Error(
                    'Zoho Expense Refund created but transaction_id was missing in response.',
                );
            }

            const candidates = resolveAttachmentCandidates(payment, attachments);
            const uploaded = [];
            const failed = [];
            for (const att of candidates) {
                const parsed = bufferFromBase64(att.data);
                if (!parsed?.buffer) continue;
                const filename =
                    clean(att.name || att.filename, 'expense-refund-attachment.pdf').slice(0, 200) ||
                    'expense-refund-attachment.pdf';
                try {
                    await uploadBankTransactionAttachment(transactionId, {
                        buffer: parsed.buffer,
                        filename,
                        mimeType: clean(att.mimeType || parsed.mimeType, 'application/pdf'),
                    });
                    uploaded.push(filename);
                } catch (attachErr) {
                    failed.push(`${filename}: ${attachErr?.message || 'upload failed'}`);
                    console.warn('[ExpenseRefundZoho] Attachment soft-fail:', attachErr?.message);
                }
            }

            return {
                expenseId: transactionId,
                expenseNumber: clean(
                    txn?.transaction_id ||
                        txn?.reference_number ||
                        txn?.expense_number ||
                        transactionId,
                ),
                locationId: resolvedLocationId,
                locationName,
                expenseAccountName: clean(expenseAccountName),
                paidThroughAccountName: clean(paidThroughAccountName),
                vendorId: resolvedVendorId,
                vendorName: clean(vendorName),
                attachmentUploaded: uploaded,
                attachmentFailed: failed,
                raw: txn,
            };
        });

        let message = `Zoho ${FINE_COMPANY_LABEL} posted to Banking (Money In).`;
        if (result.attachmentUploaded?.length) {
            message += ` Attached ${result.attachmentUploaded.length} file(s).`;
        } else if (result.attachmentFailed?.length) {
            message += ` (Attachments saved in ERP; Zoho attach failed.)`;
        }

        return {
            ok: true,
            expenseId: result.expenseId,
            expenseNumber: result.expenseNumber,
            organizationId: orgId,
            locationId: result.locationId,
            locationName: result.locationName,
            message,
        };
    } catch (err) {
        let message = err?.message || 'Failed to create Zoho Expense Refund';
        if (/valid expense account|from.?account/i.test(message)) {
            message =
                'Please enter a valid From Account from Zoho Chart of Accounts. Bank must be a different Zoho Banking account.';
        }
        if (/banking\.CREATE|not authorized|unauthorized/i.test(message)) {
            message =
                'Zoho Banking create permission missing. Reconnect Zoho and accept ZohoBooks.banking.CREATE, then retry.';
        }
        console.error('[ExpenseRefundZoho]', message);
        return { ok: false, message, organizationId: orgId };
    }
}

/**
 * Employee/company fine recovery → Zoho Books Banking Expense Refund (Money In).
 */
export async function syncFineCompanyPaymentToZoho({
    payment,
    fine,
    employee,
    organizationId = '',
    expenseAccountId = '',
    expenseAccountName = '',
    paidThroughAccountId = '',
    paidThroughAccountName = '',
    locationId = '',
    taxTreatment = '',
    placeOfSupply = '',
    taxId = '',
    isInclusiveTax = true,
    paymentMode = 'Cash',
    vendorId = '',
    vendorName = '',
    attachments = [],
} = {}) {
    if (!fine?._id) return { ok: false, message: 'Fine is required.' };
    const fineLabel = clean(fine.fineId || fine._id);
    return syncExpenseRefundPaymentToZoho({
        payment,
        employee,
        referenceLabel: `Fine ${fineLabel}`,
        organizationHint:
            clean(organizationId) ||
            clean(payment?.zohoOrganizationId) ||
            clean(fine?.zohoOrganizationId),
        requireEntityId: true,
        entityId: String(fine._id),
        expenseAccountId,
        expenseAccountName,
        paidThroughAccountId,
        paidThroughAccountName,
        locationId,
        taxTreatment,
        placeOfSupply,
        taxId,
        isInclusiveTax,
        paymentMode,
        vendorId,
        vendorName,
        attachments,
    });
}

/**
 * Utility difference recovery → Zoho Books Banking Expense Refund (Money In).
 */
export async function syncUtilityDifferencePaymentToZoho({
    payment,
    utilityBill = null,
    employee,
    organizationId = '',
    expenseAccountId = '',
    expenseAccountName = '',
    paidThroughAccountId = '',
    paidThroughAccountName = '',
    locationId = '',
    taxTreatment = '',
    placeOfSupply = '',
    taxId = '',
    isInclusiveTax = true,
    paymentMode = 'Cash',
    vendorId = '',
    vendorName = '',
    attachments = [],
} = {}) {
    const billId = clean(utilityBill?._id || payment?.relatedEntityId);
    const accountNo = clean(utilityBill?.accountNo);
    const billMonth = clean(utilityBill?.billMonth);
    const utilityType = clean(utilityBill?.utilityType);
    const referenceLabel = clean(
        `Utility ${utilityType} ${billMonth} Acc ${accountNo || billId}`.trim(),
        `Utility ${billId}`,
    );

    return syncExpenseRefundPaymentToZoho({
        payment,
        employee,
        referenceLabel,
        organizationHint:
            clean(organizationId) ||
            clean(payment?.zohoOrganizationId) ||
            clean(utilityBill?.zohoOrganizationId),
        requireEntityId: true,
        entityId: billId,
        expenseAccountId,
        expenseAccountName,
        paidThroughAccountId,
        paidThroughAccountName,
        locationId,
        taxTreatment,
        placeOfSupply,
        taxId,
        isInclusiveTax,
        paymentMode,
        vendorId: clean(vendorId) || clean(utilityBill?.zohoVendorId),
        vendorName: clean(vendorName) || clean(utilityBill?.provider),
        attachments,
    });
}

/**
 * Loan / Advance employee repayment → Zoho Books Banking Expense Refund (Money In).
 */
export async function syncLoanRepaymentPaymentToZoho({
    payment,
    loan,
    employee,
    organizationId = '',
    expenseAccountId = '',
    expenseAccountName = '',
    paidThroughAccountId = '',
    paidThroughAccountName = '',
    locationId = '',
    taxTreatment = '',
    placeOfSupply = '',
    taxId = '',
    isInclusiveTax = true,
    paymentMode = 'Cash',
    vendorId = '',
    vendorName = '',
    attachments = [],
} = {}) {
    if (!loan?._id) return { ok: false, message: 'Loan is required.' };
    const loanLabel = clean(loan.loanId || loan._id);
    const kind = String(loan.type || 'Loan').trim() === 'Advance' ? 'Advance' : 'Loan';
    return syncExpenseRefundPaymentToZoho({
        payment,
        employee,
        referenceLabel: `${kind} ${loanLabel}`,
        organizationHint:
            clean(organizationId) ||
            clean(payment?.zohoOrganizationId) ||
            clean(loan?.zohoOrganizationId),
        requireEntityId: true,
        entityId: String(loan._id),
        expenseAccountId,
        expenseAccountName,
        paidThroughAccountId,
        paidThroughAccountName,
        locationId,
        taxTreatment,
        placeOfSupply,
        taxId,
        isInclusiveTax,
        paymentMode,
        vendorId,
        vendorName,
        attachments,
    });
}
