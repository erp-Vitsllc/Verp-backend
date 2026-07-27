import {
    createVendorPayment,
    createZohoJournal,
    fetchBillById,
    fetchPaymentAccounts,
    fetchVendorPaymentById,
    updateVendorPayment,
} from '../../services/zohoService.js';
import {
    upsertZohoBillFromApi,
    upsertZohoVendorPaymentFromApi,
} from '../../services/zohoPurchaseSyncService.js';
import { mapZohoErrorStatus, toFiniteAmount } from './zohoVendorPaymentUtils.js';
import {
    recordPartyExpensesFromVendorPaymentBody,
    settleUtilityDifferenceViaJournal,
} from '../../utils/recordPartyExpenseFromZohoPayment.js';
import { getZohoOrgContext, withZohoOrganization } from '../../utils/zohoOrgContext.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function extractZohoPaymentId(payment) {
    if (!payment || typeof payment !== 'object') return '';
    return String(
        payment.payment_id || payment.vendorpayment_id || payment.id || '',
    ).trim();
}

function collectBillNumberHints(body = {}, payload = {}) {
    const hints = [];
    const push = (value) => {
        const text = String(value || '').trim();
        if (text && !hints.includes(text)) hints.push(text);
    };
    for (const bill of [].concat(body.bills || [], payload.bills || [])) {
        push(bill?.bill_number || bill?.billNumber);
    }
    push(body.reference_number || body.referenceNumber || payload.reference_number);
    return hints;
}

/**
 * Zoho create/update often returns a thin payload (or only payment_id).
 * Bills still refresh to PAID; Payments Made list needs a full local upsert.
 * Re-fetch + enrich bill numbers so the row appears and is searchable.
 */
async function hydrateVendorPaymentForLocalUpsert(rawPayment, { body = {}, payload = {}, isDraft = false } = {}) {
    let payment = rawPayment && typeof rawPayment === 'object' ? { ...rawPayment } : {};
    let paymentId = extractZohoPaymentId(payment);

    if (paymentId) {
        try {
            const full = await fetchVendorPaymentById(paymentId);
            if (full && typeof full === 'object') {
                payment = {
                    ...payment,
                    ...full,
                    payment_id: extractZohoPaymentId(full) || paymentId,
                };
            }
        } catch (err) {
            console.warn(
                '[ZohoVendorPayment] fetchVendorPaymentById after save failed:',
                err?.message || err,
            );
            payment.payment_id = payment.payment_id || paymentId;
        }
    }

    if (!payment.vendor_id && payload.vendor_id) payment.vendor_id = payload.vendor_id;
    if (!payment.vendor_name) {
        payment.vendor_name = String(body.vendor_name || body.vendorName || '').trim();
    }
    if (!payment.reference_number && payload.reference_number) {
        payment.reference_number = payload.reference_number;
    }
    if (!payment.date && payload.date) payment.date = payload.date;
    if (payment.amount == null && payload.amount != null) payment.amount = payload.amount;
    if (!payment.payment_mode && payload.payment_mode) {
        payment.payment_mode = payload.payment_mode;
    }
    if (!payment.paid_through_account_id && payload.paid_through_account_id) {
        payment.paid_through_account_id = payload.paid_through_account_id;
    }
    if (!payment.paid_through_account_name) {
        payment.paid_through_account_name = String(
            body.paid_through_account_name || body.paidThroughAccountName || '',
        ).trim();
    }

    payment.status =
        payment.status || payment.status_formatted || (isDraft ? 'draft' : 'paid');

    let billNumbers = String(payment.bill_numbers || payment.bill_number || '').trim();
    if (!billNumbers && Array.isArray(payment.bills) && payment.bills.length) {
        billNumbers = payment.bills
            .map((bill) => String(bill?.bill_number || bill?.billNumber || '').trim())
            .filter(Boolean)
            .join(', ');
    }
    if (!billNumbers) {
        const hints = collectBillNumberHints(body, payload);
        if (hints.length) billNumbers = hints.join(', ');
    }
    if (!billNumbers && Array.isArray(payload.bills) && payload.bills.length) {
        const numbers = [];
        for (const bill of payload.bills) {
            const billId = String(bill?.bill_id || bill?.billId || '').trim();
            if (!billId) continue;
            try {
                const zohoBill = await fetchBillById(billId);
                const num = String(
                    zohoBill?.bill_number || zohoBill?.reference_number || '',
                ).trim();
                if (num && !numbers.includes(num)) numbers.push(num);
            } catch {
                /* ignore single-bill lookup */
            }
        }
        if (numbers.length) billNumbers = numbers.join(', ');
    }
    if (billNumbers) payment.bill_numbers = billNumbers;

    if (!extractZohoPaymentId(payment)) {
        console.warn(
            '[ZohoVendorPayment] No payment_id after hydrate — Payments Made row may be missing. Keys:',
            Object.keys(payment).join(', ') || '(empty)',
        );
    }

    return payment;
}

function normName(value) {
    return String(value || '').trim().toLowerCase();
}

function findAccountByName(accounts = [], name = '') {
    const needle = normName(name);
    if (!needle) return null;
    const list = Array.isArray(accounts) ? accounts : [];

    const exact = list.find((a) => normName(a.account_name || a.name) === needle);
    if (exact) return exact;

    return (
        list.find((a) => {
            const accName = normName(a.account_name || a.name);
            return accName && (accName.includes(needle) || needle.includes(accName));
        }) || null
    );
}

/**
 * Paid Through may be any active Chart of Accounts row Zoho accepts
 * (bank/cash OR liability like "Salary payable - …" for employee difference settle).
 * Do not block account types here — Zoho is the source of truth.
 */

/**
 * Paid Through picked from the OTHER Zoho org (e.g. NNIT employee account on a VEGA bill).
 * Zoho cannot post a payment through a foreign-org account, so:
 *  - the vendor payment uses a same-named account in the payment org, and
 *  - a journal in the other org credits the selected (employee) account there.
 */
async function resolveCrossOrgPaidThrough(body = {}, payload = {}) {
    const crossOrgId = String(
        body.paid_through_organization_id || body.paidThroughOrganizationId || '',
    ).trim();
    if (!crossOrgId) return null;

    const activeOrgId = String(
        getZohoOrgContext()?.organizationId || process.env.ZOHO_ORGANIZATION_ID || '',
    ).trim();
    if (!activeOrgId || crossOrgId === activeOrgId) return null;

    const crossAccountId = payload.paid_through_account_id;
    const crossAccountName = String(
        body.paid_through_account_name || body.paidThroughAccountName || '',
    ).trim();
    const crossBrand =
        String(body.paid_through_org_brand || '').trim() || 'the other organization';
    const paymentBrand = String(body.payment_org_brand || '').trim() || 'this organization';

    const accounts = await fetchPaymentAccounts();
    const match = findAccountByName(accounts, crossAccountName);
    if (!match) {
        const err = new Error(
            `Paid Through "${crossAccountName || crossAccountId}" is a ${crossBrand} account. ` +
                `Zoho cannot pay a ${paymentBrand} bill through it. Create an account with the ` +
                `same name in the ${paymentBrand} Chart of Accounts, or pick a ${paymentBrand} account.`,
        );
        err.statusCode = 400;
        throw err;
    }

    payload.paid_through_account_id = String(match.account_id || match.id || '').trim();

    return {
        crossOrgId,
        crossAccountId,
        crossAccountName,
        crossBrand,
        paymentBrand,
        paymentAccountId: payload.paid_through_account_id,
        paymentAccountName: String(match.account_name || match.name || '').trim(),
    };
}

/** Journal in the other org: credit the employee's account, debit intercompany/payment-org account. */
async function postCrossOrgCreditJournal({ cross, payload, zohoPayment = {} }) {
    return withZohoOrganization(cross.crossOrgId, async () => {
        const accounts = await fetchPaymentAccounts();
        const debit =
            findAccountByName(accounts, cross.paymentBrand) ||
            accounts.find((a) =>
                /intercompany|inter[\s-]?company/i.test(String(a.account_name || a.name || '')),
            );
        if (!debit) {
            return {
                skipped: true,
                reason: `No "${cross.paymentBrand}" or intercompany account found in ${cross.crossBrand} Chart of Accounts to balance the journal.`,
            };
        }

        const reference = String(
            zohoPayment.payment_number || zohoPayment.payment_no || payload.reference_number || '',
        ).trim();
        const journal = await createZohoJournal({
            journal_date: payload.date,
            reference_number: reference || undefined,
            notes:
                `Paid through ${cross.crossAccountName} for ${cross.paymentBrand} vendor payment` +
                (reference ? ` ${reference}` : ''),
            line_items: [
                {
                    account_id: String(debit.account_id || debit.id || '').trim(),
                    amount: payload.amount,
                    debit_or_credit: 'debit',
                    description: `${cross.paymentBrand} intercompany`,
                },
                {
                    account_id: cross.crossAccountId,
                    amount: payload.amount,
                    debit_or_credit: 'credit',
                    description: cross.crossAccountName || 'Paid Through (employee)',
                },
            ],
        });

        return {
            skipped: false,
            journalId: String(journal?.journal_id || journal?.journalId || journal?.id || '').trim(),
            debitAccountName: String(debit.account_name || debit.name || '').trim(),
        };
    });
}

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
        const body = req.body || {};
        const mode = String(body.mode || body.utilityPayMode || '')
            .trim()
            .toLowerCase();
        const isDifferenceSettle = mode === 'difference' || mode === 'balance';
        const asDraft =
            body.is_draft === true ||
            body.isDraft === true ||
            String(body.status || '').toLowerCase() === 'draft';

        // Difference settle: AED Journal Credit on Salary payable — never Vendor Payment on
        // a foreign-currency bill (that converted 50 GBP → 245.49 AED Credit).
        if (isDifferenceSettle && !asDraft) {
            const settle = await settleUtilityDifferenceViaJournal({
                body,
                userId: req.user?._id || null,
            });
            return res.status(201).json({
                success: true,
                data: {
                    journal_id: settle.journalId,
                    amount: settle.amount,
                    paid_through_account_id: settle.partyAccountId,
                    paid_through_account_name: settle.partyAccountName,
                    status: 'paid',
                    settle_type: 'difference_journal',
                },
                isDraft: false,
                partyExpenses: settle.partyExpenseResults,
                message: `Difference settled: Credit AED ${Number(settle.amount).toFixed(2)} to ${settle.partyAccountName} (Journal).`,
            });
        }

        const payload = buildPaymentPayload(body);
        const isDraft = payload.is_draft === true;
        const crossOrgPaidThrough = await resolveCrossOrgPaidThrough(body, payload);

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

        let syncedPayment = data;
        try {
            syncedPayment = await hydrateVendorPaymentForLocalUpsert(data, {
                body,
                payload,
                isDraft,
            });
            const upserted = await upsertZohoVendorPaymentFromApi(syncedPayment);
            if (!upserted) {
                console.warn(
                    '[ZohoVendorPaymentCreate] Local Payments Made upsert skipped (missing payment_id). Bill may still show Paid.',
                );
            }
            data = syncedPayment;
        } catch (syncError) {
            console.warn(
                '[ZohoVendorPaymentCreate] Zoho create ok; local DB upsert failed:',
                syncError?.message || syncError,
            );
        }

        // Cross-org Paid Through: credit the selected account inside the other org
        // (shows in that employee's account there), balanced by an intercompany debit.
        let crossOrgJournalNote = '';
        if (!isDraft && crossOrgPaidThrough) {
            try {
                const journalResult = await postCrossOrgCreditJournal({
                    cross: crossOrgPaidThrough,
                    payload,
                    zohoPayment: data && typeof data === 'object' ? data : {},
                });
                crossOrgJournalNote = journalResult.skipped
                    ? ` Credit journal in ${crossOrgPaidThrough.crossBrand} was skipped: ${journalResult.reason}`
                    : ` A credit journal was posted in ${crossOrgPaidThrough.crossBrand} against ${crossOrgPaidThrough.crossAccountName}.`;
            } catch (journalErr) {
                console.warn(
                    '[ZohoVendorPaymentCreate] Cross-org credit journal failed:',
                    journalErr?.message || journalErr,
                );
                crossOrgJournalNote = ` Credit journal in ${crossOrgPaidThrough.crossBrand} failed: ${journalErr?.message || journalErr}`;
            }
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
            message:
                (isDraft
                    ? 'Payment made has been saved as draft in Zoho Books.'
                    : 'Payment made recorded as paid in Zoho. Related Expenses marked Paid with debit/credit ledger.') +
                crossOrgJournalNote,
        });
    } catch (error) {
        console.error('[ZohoVendorPaymentCreate] Failed:', error?.message || error);

        const message = error?.message || 'Failed to create payment made in Zoho Books';
        const isValidationError =
            /required|greater than|YYYY-MM-DD|cannot be greater/i.test(message);

        return res
            .status(error?.statusCode || (isValidationError ? 400 : mapZohoErrorStatus(message)))
            .json({
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
        // Swap foreign-org Paid Through for the same-named payment-org account (no new journal on edit).
        await resolveCrossOrgPaidThrough(req.body || {}, payload);
        let data = await updateVendorPayment(paymentId, payload);

        try {
            data = await hydrateVendorPaymentForLocalUpsert(data, {
                body: req.body || {},
                payload,
                isDraft,
            });
            if (!extractZohoPaymentId(data)) {
                data.payment_id = paymentId;
            }
            const upserted = await upsertZohoVendorPaymentFromApi(data);
            if (!upserted) {
                console.warn(
                    '[ZohoVendorPaymentUpdate] Local Payments Made upsert skipped (missing payment_id).',
                );
            }
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

        return res
            .status(error?.statusCode || (isValidationError ? 400 : mapZohoErrorStatus(message)))
            .json({
                success: false,
                message,
            });
    }
};
