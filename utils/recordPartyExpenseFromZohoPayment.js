import PartyExpense from '../models/PartyExpense.js';
import {
    createZohoJournal,
    fetchPaymentAccounts,
    fetchTransactionJournalView,
} from '../services/zohoService.js';

const COMPANY_PARTY_ID = 'VEGA-HR-0000';

function clean(value, fallback = '') {
    const text = String(value ?? '').trim();
    return text || fallback;
}

function money(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function normalizePayBy(value) {
    const v = clean(value).toLowerCase();
    if (v === 'employee_balance') return 'employee';
    if (v === 'company' || v === 'employee' || v === 'employee_and_company') return v;
    return '';
}

function findCreditAccount(accounts = [], { employeeName = '', companyName = '' } = {}) {
    const needle = clean(employeeName || companyName).toLowerCase();
    const list = Array.isArray(accounts) ? accounts : [];

    const byName = needle
        ? list.find((a) => clean(a.account_name || a.name).toLowerCase().includes(needle))
        : null;
    if (byName) {
        return {
            id: clean(byName.account_id || byName.id),
            name: clean(byName.account_name || byName.name),
        };
    }

    const payable = list.find((a) => {
        const type = clean(a.account_type || a.account_type_formatted).toLowerCase();
        const name = clean(a.account_name || a.name).toLowerCase();
        return /accounts payable|other current liability|liability/.test(type) || /payable/.test(name);
    });
    if (payable) {
        return {
            id: clean(payable.account_id || payable.id),
            name: clean(payable.account_name || payable.name, 'Accounts Payable'),
        };
    }
    return { id: '', name: needle ? `Payable — ${needle}` : 'Accounts Payable' };
}

/** Map Zoho journal / journal-view lines → locked local ledger rows. */
export function ledgerFromZohoLines(lines = [], fallbackAmount = 0) {
    const rows = [];
    for (const line of Array.isArray(lines) ? lines : []) {
        const sideRaw = clean(
            line?.debit_or_credit || line?.debitOrCredit || line?.transaction_type,
        ).toLowerCase();
        let side = '';
        if (sideRaw.includes('debit') || sideRaw === 'dr') side = 'debit';
        if (sideRaw.includes('credit') || sideRaw === 'cr') side = 'credit';
        if (!side) continue;

        const amount = money(
            line?.amount ?? line?.bcy_amount ?? line?.debit_amount ?? line?.credit_amount ?? fallbackAmount,
        );
        if (amount <= 0) continue;

        rows.push({
            side,
            accountId: clean(line?.account_id || line?.accountId),
            accountName: clean(line?.account_name || line?.accountName, side),
            amount,
            notes: clean(line?.description || line?.notes, `Zoho ${side}`),
            locked: true,
            createdAt: new Date(),
        });
    }
    return rows;
}

/**
 * Prefer Zoho's own debit/credit for a vendor payment transaction.
 * Falls back to null when journal view is unavailable.
 */
export async function fetchZohoPaymentLedgerLines(zohoPaymentId) {
    const id = clean(zohoPaymentId);
    if (!id) return null;

    try {
        const data = await fetchTransactionJournalView(id, { entityType: 'vendor_payment' });
        const lines =
            data?.journal?.line_items ||
            data?.line_items ||
            data?.journals?.[0]?.line_items ||
            data?.transaction?.line_items ||
            [];
        const mapped = ledgerFromZohoLines(lines);
        if (mapped.length) {
            return {
                lines: mapped,
                journalId: clean(
                    data?.journal?.journal_id ||
                        data?.journals?.[0]?.journal_id ||
                        data?.journal_id ||
                        data?.transaction_id,
                ),
                source: 'transactions/journals',
            };
        }
    } catch (err) {
        console.warn(
            '[PartyExpense] Zoho payment journal view failed:',
            err?.message || err,
        );
    }
    return null;
}

async function tryPostZohoJournal({
    date,
    amount,
    debitAccountId,
    debitAccountName,
    creditAccountId,
    creditAccountName,
    reference,
    notes,
}) {
    if (!debitAccountId || !creditAccountId || debitAccountId === creditAccountId) {
        return { journalId: '', lines: [], skipped: true };
    }
    try {
        const journal = await createZohoJournal({
            journal_date: date,
            reference_number: reference || undefined,
            notes: notes || 'Party expense (Payments Made)',
            line_items: [
                {
                    account_id: debitAccountId,
                    amount,
                    debit_or_credit: 'debit',
                    description: debitAccountName || 'Debit',
                },
                {
                    account_id: creditAccountId,
                    amount,
                    debit_or_credit: 'credit',
                    description: creditAccountName || 'Credit',
                },
            ],
        });
        const lines = ledgerFromZohoLines(journal?.line_items || [], amount);
        return {
            journalId: clean(journal?.journal_id || journal?.journalId || journal?.id),
            lines,
            skipped: false,
        };
    } catch (err) {
        console.warn('[PartyExpense] Zoho journal failed:', err?.message || err);
        return { journalId: '', lines: [], skipped: true, error: err?.message || String(err) };
    }
}

function appendLockedLedger(doc, lines = []) {
    if (!Array.isArray(doc.ledger)) doc.ledger = [];
    for (const line of lines) {
        const exists = doc.ledger.some(
            (l) =>
                l.side === line.side &&
                clean(l.accountId) === clean(line.accountId) &&
                money(l.amount) === money(line.amount),
        );
        if (!exists) {
            doc.ledger.push({ ...line, locked: true });
        }
    }
}

/**
 * After Zoho Payments Made is Saved as Paid: mark Expense Paid and mirror Zoho debit/credit.
 */
export async function recordPartyExpensePaidFromZoho({
    body = {},
    zohoPayment = {},
    userId = null,
} = {}) {
    const amount = money(body.amount ?? zohoPayment.amount);
    if (amount <= 0) {
        throw new Error('Amount must be greater than zero.');
    }

    const payBy = normalizePayBy(body.payBy);
    const isCompany = payBy === 'company' || clean(body.partyType) === 'company';
    const employeeId = isCompany
        ? COMPANY_PARTY_ID
        : clean(body.employeeId || body.payByEmployeeId);
    const employeeName = isCompany
        ? clean(body.companyName || body.payByCompanyName, 'VEGA Digital')
        : clean(body.employeeName || body.payByEmployeeName);
    const companyId = clean(body.companyId || body.payByCompanyId);
    const companyName = clean(body.companyName || body.payByCompanyName, 'VEGA Digital');

    if (!employeeId && !isCompany) {
        throw new Error('employeeId is required for employee expenses.');
    }

    const paidThroughAccountId = clean(
        body.paidThroughAccountId ||
            body.paid_through_account_id ||
            zohoPayment.paid_through_account_id ||
            zohoPayment.account_id,
    );
    const paidThroughAccountName = clean(
        body.paidThroughAccountName ||
            body.paid_through_account_name ||
            zohoPayment.paid_through_account_name ||
            zohoPayment.account_name,
        'Paid Through',
    );
    if (!paidThroughAccountId) {
        throw new Error('paidThroughAccountId is required.');
    }

    const utilityBillId = clean(body.utilityBillId);
    const date =
        clean(body.date || zohoPayment.date) || new Date().toISOString().slice(0, 10);
    const zohoPaymentId = clean(
        body.zohoPaymentId ||
            body.payment_id ||
            zohoPayment.payment_id ||
            zohoPayment.vendorpayment_id ||
            zohoPayment.id,
    );
    const zohoOrganizationId = clean(body.organizationId || body.zohoOrganizationId);
    const zohoPaymentNumber = clean(
        body.zohoPaymentNumber || zohoPayment.payment_number || zohoPayment.payment_no,
    );

    // 1) Prefer Zoho payment's own debit/credit (journal view).
    let zohoLedger = zohoPaymentId ? await fetchZohoPaymentLedgerLines(zohoPaymentId) : null;

    // 2) Else build / post a balancing journal and use those lines.
    let creditAccount = {
        id: clean(body.creditAccountId),
        name: clean(body.creditAccountName),
    };
    if (!zohoLedger?.lines?.length && !creditAccount.id) {
        try {
            const accounts = await fetchPaymentAccounts();
            creditAccount = findCreditAccount(accounts, {
                employeeName: isCompany ? companyName : employeeName,
                companyName,
            });
        } catch (err) {
            console.warn('[PartyExpense] COA load for credit failed:', err?.message || err);
            creditAccount = {
                id: '',
                name: isCompany
                    ? `Payable — ${companyName}`
                    : `Payable — ${employeeName || employeeId}`,
            };
        }
    }

    let journalResult = { journalId: '', lines: [], skipped: true };
    if (!zohoLedger?.lines?.length) {
        // Zoho vendor payment: AP debit + Paid Through credit is the natural pair.
        // User-facing Expenses ledger: show Paid Through as credit after pay, AP/payable as debit.
        const debitAccountId = creditAccount.id || paidThroughAccountId;
        const debitAccountName =
            creditAccount.name ||
            (isCompany ? `Payable — ${companyName}` : `Payable — ${employeeName || employeeId}`);
        const creditAccountId = paidThroughAccountId;
        const creditAccountName = paidThroughAccountName;

        journalResult = await tryPostZohoJournal({
            date,
            amount,
            debitAccountId,
            debitAccountName,
            creditAccountId,
            creditAccountName,
            reference: clean(body.referenceNumber || zohoPaymentNumber || utilityBillId),
            notes: clean(body.description || body.notes),
        });

        if (!journalResult.lines?.length) {
            journalResult.lines = [
                {
                    side: 'debit',
                    accountId: debitAccountId,
                    accountName: debitAccountName,
                    amount,
                    notes: 'Debit (Accounts Payable / party)',
                    locked: true,
                    createdAt: new Date(),
                },
                {
                    side: 'credit',
                    accountId: creditAccountId,
                    accountName: creditAccountName,
                    amount,
                    notes: 'Credit (Paid Through) — no deletion',
                    locked: true,
                    createdAt: new Date(),
                },
            ];
        }
    }

    const ledgerLines = zohoLedger?.lines?.length ? zohoLedger.lines : journalResult.lines;

    const filter = utilityBillId
        ? {
              utilityBillId,
              kind: 'balance',
              partyType: isCompany ? 'company' : 'employee',
              ...(isCompany ? {} : { employeeId }),
          }
        : {
              zohoPaymentId: zohoPaymentId || `tmp-${Date.now()}`,
              kind: 'balance',
              partyType: isCompany ? 'company' : 'employee',
              ...(isCompany ? {} : { employeeId }),
          };

    let doc = await PartyExpense.findOne(filter);
    if (!doc) {
        doc = new PartyExpense({
            partyType: isCompany ? 'company' : 'employee',
            kind: 'balance',
            employeeId: isCompany ? COMPANY_PARTY_ID : employeeId,
            employeeName,
            companyId,
            companyName,
            utilityBillId,
            createdBy: userId || null,
            ledger: [],
        });
    }

    appendLockedLedger(doc, ledgerLines);

    // Balance payment only — status Paid after Zoho Save as Paid on the difference/balance.
    doc.kind = 'balance';
    doc.status = 'Paid';
    doc.amount = amount;
    doc.description = clean(
        body.description ||
            `Balance payment · ${isCompany ? companyName : employeeName} · ${paidThroughAccountName}`,
    );
    doc.utilityBatchId = clean(body.utilityBatchId || doc.utilityBatchId);
    doc.accountNo = clean(body.accountNo || doc.accountNo);
    doc.utilityType = clean(body.utilityType || doc.utilityType);
    doc.billMonth = clean(body.billMonth || doc.billMonth);
    doc.entryId = clean(body.entryId || doc.entryId);
    doc.zohoBillId = clean(body.zohoBillId || doc.zohoBillId);
    doc.zohoPaymentId = zohoPaymentId || doc.zohoPaymentId;
    doc.zohoPaymentNumber = zohoPaymentNumber || doc.zohoPaymentNumber;
    doc.zohoOrganizationId = zohoOrganizationId || doc.zohoOrganizationId;
    doc.zohoJournalId =
        clean(zohoLedger?.journalId || journalResult.journalId) || doc.zohoJournalId;
    doc.paidThroughAccountId = paidThroughAccountId;
    doc.paidThroughAccountName = paidThroughAccountName;
    doc.paymentMode = clean(body.paymentMode || zohoPayment.payment_mode || doc.paymentMode);
    doc.paidAt = new Date();
    doc.erpPaymentId = clean(body.erpPaymentId || doc.erpPaymentId);
    doc.currencyCode = clean(body.currencyCode || zohoPayment.currency_code, 'AED');

    await doc.save();

    // Do NOT mark utility vendor bill Paid here — that is separate from balance Pay By.

    return {
        expense: doc.toObject(),
        ledgerSource: zohoLedger?.source || (journalResult.skipped ? 'local' : 'zoho_journal'),
        journalId: doc.zohoJournalId,
    };
}

/**
 * Process party_expenses[] from Payments Made Save as Paid body.
 */
export async function recordPartyExpensesFromVendorPaymentBody({
    body = {},
    zohoPayment = {},
    userId = null,
} = {}) {
    // Full vendor bill pay must not close profile balance or post balance debit/credit.
    const mode = clean(body.mode || body.utilityPayMode).toLowerCase();
    if (mode && mode !== 'difference' && mode !== 'balance') {
        return [];
    }

    const list = Array.isArray(body.party_expenses)
        ? body.party_expenses
        : Array.isArray(body.partyExpenses)
          ? body.partyExpenses
          : [];
    if (!list.length) return [];

    const paidThroughAccountId = clean(
        body.paid_through_account_id ||
            body.paidThroughAccountId ||
            zohoPayment.paid_through_account_id,
    );
    const paidThroughAccountName = clean(
        body.paid_through_account_name ||
            body.paidThroughAccountName ||
            zohoPayment.paid_through_account_name,
    );
    const shared = {
        date: clean(body.date || zohoPayment.date),
        zohoPaymentId: clean(
            zohoPayment.payment_id || zohoPayment.vendorpayment_id || zohoPayment.id,
        ),
        zohoPaymentNumber: clean(zohoPayment.payment_number || zohoPayment.payment_no),
        organizationId: clean(body.organizationId || body.zohoOrganizationId),
        paidThroughAccountId,
        paidThroughAccountName,
        paymentMode: clean(body.payment_mode || body.paymentMode || zohoPayment.payment_mode),
        notes: clean(body.description || body.notes),
        description: clean(body.description || body.notes),
        currencyCode: clean(body.currency_code || zohoPayment.currency_code, 'AED'),
        utilityType: clean(body.utilityType),
        billMonth: clean(body.billMonth),
        utilityBatchId: clean(body.utilityBatchId),
    };

    const results = [];
    for (const row of list) {
        try {
            const recorded = await recordPartyExpensePaidFromZoho({
                body: { ...shared, ...row },
                zohoPayment,
                userId,
            });
            results.push({ ok: true, expense: recorded.expense, ledgerSource: recorded.ledgerSource });
        } catch (err) {
            console.error('[PartyExpense] row failed:', err?.message || err);
            results.push({ ok: false, message: err?.message || String(err), row });
        }
    }
    return results;
}
