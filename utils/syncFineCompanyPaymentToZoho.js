import ZohoExpense from '../models/ZohoExpense.js';
import {
    createExpense,
    fetchLocations,
    getZohoOrganizationId,
} from '../services/zohoService.js';
import { mapZohoExpenseToDoc } from './zohoPurchaseMappers.js';
import { withZohoOrganization } from './zohoOrgContext.js';
import { resolveZohoOrganizationIdForRewardEmployee } from './syncRewardPaymentToZoho.js';

const DEFAULT_LOCATION_NAME = 'Head Office';
const DEFAULT_TAX_TREATMENT = 'vat_not_registered';
const DEFAULT_PLACE_OF_SUPPLY = 'DU';
const DEFAULT_CURRENCY = 'AED';
/** Fixed transaction expense label for employee → company fine recovery. */
const FINE_COMPANY_TRANSACTION_EXPENSE = 'Refund';

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
 * Employee/company fine recovery → Zoho Books Expense:
 * Banking = paid_through · From Account = expense account ·
 * Transaction expense = Refund (fixed) · Tax always exclusive.
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
} = {}) {
    const amount = money(payment?.amount);
    const debitId = clean(expenseAccountId || payment?.expenseAccountId);
    const creditId = clean(paidThroughAccountId || payment?.paidThroughAccountId);

    if (!fine?._id) return { ok: false, message: 'Fine is required.' };
    if (amount <= 0) return { ok: false, message: 'Payment amount is required for Zoho Expense.' };
    if (!debitId || !creditId) {
        return {
            ok: false,
            message: 'Banking and From Account are required for Zoho Chart of Accounts posting.',
        };
    }
    if (debitId === creditId) {
        return {
            ok: false,
            message: 'Banking and From Account must be different accounts.',
        };
    }

    if (clean(payment?.zohoExpenseId)) {
        return {
            ok: true,
            skipped: true,
            expenseId: clean(payment.zohoExpenseId),
            organizationId: clean(payment.zohoOrganizationId) || getZohoOrganizationId(),
            message: 'Zoho Expense already exists for this payment.',
        };
    }

    const orgId =
        clean(organizationId) ||
        clean(payment?.zohoOrganizationId) ||
        clean(fine?.zohoOrganizationId) ||
        (await resolveZohoOrganizationIdForRewardEmployee(employee));

    const date =
        toDateKey(payment?.paymentDate) ||
        toDateKey(payment?.createdAt) ||
        new Date().toISOString().slice(0, 10);

    const fineLabel = clean(fine.fineId || fine._id);
    const description = clean(
        `${FINE_COMPANY_TRANSACTION_EXPENSE} · Fine ${fineLabel} · ${clean(employee?.employeeId || '')}`,
        FINE_COMPANY_TRANSACTION_EXPENSE,
    ).slice(0, 500);
    const referenceNumber = clean(
        `${FINE_COMPANY_TRANSACTION_EXPENSE}-${fineLabel}`,
        FINE_COMPANY_TRANSACTION_EXPENSE,
    ).slice(0, 100);

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
                is_inclusive_tax: false,
                tax_treatment: taxTreatment,
                place_of_supply: placeOfSupply,
                location_id: locationId,
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
                    '[FineCompanyZoho] Local ZohoExpense cache upsert failed:',
                    cacheErr?.message || cacheErr,
                );
            }

            return {
                expenseId,
                expenseNumber: clean(expense?.expense_number || expense?.expenseNumber),
                locationId,
                locationName,
                expenseAccountName: clean(expenseAccountName),
                paidThroughAccountName: clean(paidThroughAccountName),
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
            message: `Zoho Expense created (${FINE_COMPANY_TRANSACTION_EXPENSE}) and posted to banking / Chart of Accounts.`,
        };
    } catch (err) {
        let message = err?.message || 'Failed to create Zoho Expense for fine company payment';
        if (/valid expense account/i.test(message)) {
            message =
                'Please enter a valid From Account. It must be a Zoho Expense / P&L account — not Cash, Bank, or Petty Cash. Use Cash/Bank only in Banking.';
        }
        console.error('[FineCompanyZoho]', message);
        return { ok: false, message, organizationId: orgId };
    }
}
