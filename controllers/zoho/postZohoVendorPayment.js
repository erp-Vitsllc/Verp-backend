import { createVendorPayment, fetchBillById, updateVendorPayment } from '../../services/zohoService.js';
import {
    upsertZohoBillFromApi,
    upsertZohoVendorPaymentFromApi,
} from '../../services/zohoPurchaseSyncService.js';
import { mapZohoErrorStatus, toFiniteAmount } from './zohoVendorPaymentUtils.js';
import { recordPartyExpensesFromVendorPaymentBody } from '../../utils/recordPartyExpenseFromZohoPayment.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cleanBills(bills, paymentAmount) {
    if (!Array.isArray(bills)) return [];

    const clean = bills
        .map((bill) => {
            const billId = String(bill?.bill_id || bill?.billId || '').trim();
            const amountApplied = toFiniteAmount(bill?.amount_applied ?? bill?.amountApplied);

            if (!billId || !Number.isFinite(amountApplied) || amountApplied <= 0) {
                return null;
            }

            return {
                bill_id: billId,
                amount_applied: Number(amountApplied.toFixed(2)),
            };
        })
        .filter(Boolean);

    return clean;
}

function cleanExpenses(expenses, paymentAmount, appliedBillTotal = 0) {
    if (!Array.isArray(expenses)) return [];

    const clean = expenses
        .map((expense) => {
            const expenseId = String(expense?.expense_id || expense?.expenseId || '').trim();
            const amountApplied = toFiniteAmount(expense?.amount_applied ?? expense?.amountApplied);

            if (!expenseId || !Number.isFinite(amountApplied) || amountApplied <= 0) {
                return null;
            }

            return {
                expense_id: expenseId,
                amount_applied: Number(amountApplied.toFixed(2)),
            };
        })
        .filter(Boolean);

    const totalApplied =
        appliedBillTotal + clean.reduce((sum, expense) => sum + expense.amount_applied, 0);
    if (totalApplied - paymentAmount > 0.01) {
        throw new Error('Applied bill and expense amount cannot be greater than the payment amount.');
    }

    return clean;
}

function resolveIsDraft(body = {}) {
    const raw = body.is_draft ?? body.isDraft ?? body.save_as_draft ?? body.saveAsDraft;
    if (raw === true || raw === 1 || raw === '1') return true;
    if (raw === false || raw === 0 || raw === '0') return false;
    const status = String(body.status || body.payment_status || '').trim().toLowerCase();
    if (status === 'draft') return true;
    if (status === 'paid') return false;
    return false;
}

function buildPaymentPayload(body = {}) {
    const vendorId = String(body.vendor_id || body.vendorId || '').trim();
    const date = String(body.date || '').trim();
    const amount = toFiniteAmount(body.amount);
    const paidThroughAccountId = String(
        body.paid_through_account_id || body.paidThroughAccountId || '',
    ).trim();
    const paymentMode = String(body.payment_mode || body.paymentMode || '').trim();
    const referenceNumber = String(body.reference_number || body.referenceNumber || '').trim();
    const description = String(body.description || '').trim();
    const locationId = String(body.location_id || body.locationId || '').trim();
    const isDraft = resolveIsDraft(body);

    if (!vendorId) throw new Error('Vendor is required.');
    if (!DATE_RE.test(date)) throw new Error('Payment date must use YYYY-MM-DD format.');
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Payment amount must be greater than zero.');
    if (!paidThroughAccountId) throw new Error('Paid through account is required.');
    if (!paymentMode) throw new Error('Payment mode is required.');

    const payload = {
        vendor_id: vendorId,
        date,
        amount: Number(amount.toFixed(2)),
        paid_through_account_id: paidThroughAccountId,
        payment_mode: paymentMode,
        // Zoho Books UI: Save as Draft vs Save as Paid
        is_draft: isDraft,
    };

    if (referenceNumber) payload.reference_number = referenceNumber;
    if (description) payload.description = description;
    if (locationId) payload.location_id = locationId;

    const bills = cleanBills(body.bills, payload.amount);
    const billTotal = bills.reduce((sum, bill) => sum + bill.amount_applied, 0);
    if (billTotal - payload.amount > 0.01) {
        throw new Error('Applied bill amount cannot be greater than the payment amount.');
    }
    if (bills.length) payload.bills = bills;

    const expenses = cleanExpenses(body.expenses, payload.amount, billTotal);
    if (expenses.length) payload.expenses = expenses;

    const totalApplied =
        billTotal + expenses.reduce((sum, expense) => sum + expense.amount_applied, 0);
    if (totalApplied - payload.amount > 0.01) {
        throw new Error('Applied bill and expense amount cannot be greater than the payment amount.');
    }

    return payload;
}

/** Refresh local bill rows so ERP Bills list shows Paid / updated balance. */
async function refreshAppliedBills(bills = []) {
    const ids = [
        ...new Set(
            (Array.isArray(bills) ? bills : [])
                .map((bill) => String(bill?.bill_id || bill?.billId || '').trim())
                .filter(Boolean),
        ),
    ];
    if (!ids.length) return;

    await Promise.all(
        ids.map(async (billId) => {
            try {
                const bill = await fetchBillById(billId);
                if (bill) await upsertZohoBillFromApi(bill);
            } catch (error) {
                console.warn(
                    `[ZohoVendorPayment] Bill refresh failed (${billId}):`,
                    error?.message || error,
                );
            }
        }),
    );
}

export const postZohoVendorPayment = async (req, res) => {
    try {
        const payload = buildPaymentPayload(req.body || {});
        const isDraft = payload.is_draft === true;

        let data;
        try {
            data = await createVendorPayment(payload);
        } catch (createError) {
            // Some Zoho orgs reject is_draft on vendorpayments — retry paid-path only when not drafting.
            const msg = String(createError?.message || createError || '');
            if (isDraft && /is_draft|draft|invalid|unknown|JSON|extra/i.test(msg)) {
                console.warn(
                    '[ZohoVendorPaymentCreate] is_draft rejected by Zoho; draft save unavailable:',
                    msg,
                );
                return res.status(400).json({
                    success: false,
                    message:
                        'Zoho Books did not accept Save as Draft for this organization. Use Save as Paid, or enable payment drafts/approvals in Zoho.',
                });
            }
            throw createError;
        }

        try {
            // Prefer Zoho response status; fall back to requested draft/paid intent.
            const synced = data && typeof data === 'object'
                ? {
                      ...data,
                      status:
                          data.status ||
                          data.status_formatted ||
                          (isDraft ? 'draft' : 'paid'),
                  }
                : data;
            await upsertZohoVendorPaymentFromApi(synced);
        } catch (syncError) {
            console.warn(
                '[ZohoVendorPaymentCreate] Zoho create ok; local DB upsert failed:',
                syncError?.message || syncError,
            );
        }

        // Draft payments do not settle bills / expenses yet.
        let partyExpenseResults = [];
        if (!isDraft) {
            await refreshAppliedBills(payload.bills);
            try {
                partyExpenseResults = await recordPartyExpensesFromVendorPaymentBody({
                    body: {
                        ...(req.body || {}),
                        paid_through_account_id: payload.paid_through_account_id,
                        paid_through_account_name:
                            req.body?.paid_through_account_name ||
                            req.body?.paidThroughAccountName ||
                            '',
                        payment_mode: payload.payment_mode,
                        date: payload.date,
                        description: payload.description,
                    },
                    zohoPayment: data && typeof data === 'object' ? data : {},
                    userId: req.user?._id || null,
                });
            } catch (expenseErr) {
                console.warn(
                    '[ZohoVendorPaymentCreate] Party expense Paid/ledger sync failed:',
                    expenseErr?.message || expenseErr,
                );
            }

            const fineIdsRaw = req.body?.fineMongoIds ?? req.body?.fineMongoId;
            const fineMongoIds = []
                .concat(fineIdsRaw || [])
                .map((id) => String(id || '').trim())
                .filter(Boolean);
            if (fineMongoIds.length) {
                try {
                    const { finalizeFineVendorPayment } = await import(
                        '../../utils/finalizeFineVendorPayment.js'
                    );
                    for (const fineMongoId of fineMongoIds) {
                        await finalizeFineVendorPayment({
                            fineMongoId,
                            zohoPayment: data && typeof data === 'object' ? data : {},
                            paidThroughAccountId: payload.paid_through_account_id,
                            paidThroughAccountName:
                                req.body?.paid_through_account_name ||
                                req.body?.paidThroughAccountName ||
                                '',
                            paymentMode: payload.payment_mode,
                            userId: req.user?._id || null,
                        });
                    }
                } catch (fineErr) {
                    console.warn(
                        '[ZohoVendorPaymentCreate] Fine vendor settle failed:',
                        fineErr?.message || fineErr,
                    );
                }
            }
        }

        return res.status(201).json({
            success: true,
            data,
            isDraft,
            partyExpenses: partyExpenseResults,
            message: isDraft
                ? 'Payment made has been saved as draft in Zoho Books.'
                : 'Payment made recorded as paid in Zoho. Related Expenses marked Paid with debit/credit ledger.',
        });
    } catch (error) {
        console.error('[ZohoVendorPaymentCreate] Failed:', error?.message || error);

        const message = error?.message || 'Failed to create payment made in Zoho Books';
        const isValidationError =
            /required|greater than|YYYY-MM-DD|cannot be greater/i.test(message);

        return res.status(isValidationError ? 400 : mapZohoErrorStatus(message)).json({
            success: false,
            message,
        });
    }
};

export const putZohoVendorPayment = async (req, res) => {
    try {
        const paymentId = String(req.params?.paymentId || '').trim();
        if (!paymentId) {
            return res.status(400).json({ success: false, message: 'Payment id is required.' });
        }

        const payload = buildPaymentPayload(req.body || {});
        const isDraft = payload.is_draft === true;
        const data = await updateVendorPayment(paymentId, payload);

        try {
            const synced = data && typeof data === 'object'
                ? {
                      ...data,
                      status:
                          data.status ||
                          data.status_formatted ||
                          (isDraft ? 'draft' : 'paid'),
                  }
                : data;
            await upsertZohoVendorPaymentFromApi(synced);
        } catch (syncError) {
            console.warn(
                '[ZohoVendorPaymentUpdate] Zoho update ok; local DB upsert failed:',
                syncError?.message || syncError,
            );
        }

        let partyExpenseResults = [];
        if (!isDraft) {
            await refreshAppliedBills(payload.bills);
            try {
                partyExpenseResults = await recordPartyExpensesFromVendorPaymentBody({
                    body: {
                        ...(req.body || {}),
                        paid_through_account_id: payload.paid_through_account_id,
                        paid_through_account_name:
                            req.body?.paid_through_account_name ||
                            req.body?.paidThroughAccountName ||
                            '',
                        payment_mode: payload.payment_mode,
                        date: payload.date,
                        description: payload.description,
                    },
                    zohoPayment: data && typeof data === 'object' ? data : {},
                    userId: req.user?._id || null,
                });
            } catch (expenseErr) {
                console.warn(
                    '[ZohoVendorPaymentUpdate] Party expense Paid/ledger sync failed:',
                    expenseErr?.message || expenseErr,
                );
            }

            const fineIdsRaw = req.body?.fineMongoIds ?? req.body?.fineMongoId;
            const fineMongoIds = []
                .concat(fineIdsRaw || [])
                .map((id) => String(id || '').trim())
                .filter(Boolean);
            if (fineMongoIds.length) {
                try {
                    const { finalizeFineVendorPayment } = await import(
                        '../../utils/finalizeFineVendorPayment.js'
                    );
                    for (const fineMongoId of fineMongoIds) {
                        await finalizeFineVendorPayment({
                            fineMongoId,
                            zohoPayment: data && typeof data === 'object' ? data : {},
                            paidThroughAccountId: payload.paid_through_account_id,
                            paidThroughAccountName:
                                req.body?.paid_through_account_name ||
                                req.body?.paidThroughAccountName ||
                                '',
                            paymentMode: payload.payment_mode,
                            userId: req.user?._id || null,
                        });
                    }
                } catch (fineErr) {
                    console.warn(
                        '[ZohoVendorPaymentUpdate] Fine vendor settle failed:',
                        fineErr?.message || fineErr,
                    );
                }
            }
        }

        return res.status(200).json({
            success: true,
            data,
            isDraft,
            partyExpenses: partyExpenseResults,
            message: isDraft
                ? 'Payment made has been updated as draft in Zoho Books.'
                : 'Payment made updated as paid. Related Expenses marked Paid with debit/credit ledger.',
        });
    } catch (error) {
        console.error('[ZohoVendorPaymentUpdate] Failed:', error?.message || error);

        const message = error?.message || 'Failed to update payment made in Zoho Books';
        const isValidationError =
            /required|greater than|YYYY-MM-DD|cannot be greater/i.test(message);

        return res.status(isValidationError ? 400 : mapZohoErrorStatus(message)).json({
            success: false,
            message,
        });
    }
};
