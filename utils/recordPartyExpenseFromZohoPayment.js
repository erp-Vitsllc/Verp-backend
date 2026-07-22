import PartyExpense from '../models/PartyExpense.js';
import UtilityBillPayment from '../models/UtilityBillPayment.js';
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

function accountCode(account) {
    return clean(account?.account_code || account?.accountCode || account?.code);
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

    const utilityBill = utilityBillId
        ? await UtilityBillPayment.findById(utilityBillId)
              .select(
                  'partyAccountId partyAccountName partyAccountCode expenseAccountId expenseAccountName',
              )
              .lean()
        : null;
    let partyAccountId = clean(body.partyAccountId || utilityBill?.partyAccountId);
    let partyAccountName = clean(body.partyAccountName || utilityBill?.partyAccountName);
    const partyAccountCode = clean(
        body.partyAccountCode ||
            utilityBill?.partyAccountCode ||
            (isCompany ? companyId : employeeId),
    );

    // Never fall back to display-name matching: account_code is the party identity.
    if (!partyAccountId && partyAccountCode) {
        const accounts = await fetchPaymentAccounts();
        const match = accounts.find(
            (row) => accountCode(row).toLowerCase() === partyAccountCode.toLowerCase(),
        );
        partyAccountId = clean(match?.account_id || match?.id);
        partyAccountName = clean(match?.account_name || match?.name);
    }
    if (!partyAccountId) {
        throw new Error(
            `No Zoho Chart of Accounts row matches account code "${partyAccountCode || (isCompany ? companyId : employeeId)}".`,
        );
    }

    const settleJournalAlreadyPosted = Boolean(clean(body.zohoJournalId || zohoPayment.journal_id));
    const settlingViaSalaryPayable = partyAccountId === paidThroughAccountId;

    // Payments Made settle: Debit Paid Through · Credit Acc2 (clears HR Approve Debit).
    const ledgerLines = [
        {
            side: 'debit',
            accountId: paidThroughAccountId,
            accountName: paidThroughAccountName,
            amount,
            notes: 'Debit (Paid Through)',
            locked: true,
            createdAt: new Date(),
        },
        {
            side: 'credit',
            accountId: partyAccountId,
            accountName: partyAccountName || partyAccountCode,
            amount,
            notes: `Credit Acc2 (${partyAccountCode || 'salary payable'})`,
            locked: true,
            createdAt: new Date(),
        },
    ];

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

    // Settle journal already posted by settleUtilityDifferenceViaJournal — do not reclassify.
    let reclassificationJournalId = clean(doc.zohoJournalId || body.zohoJournalId);
    const expenseAccountId = clean(utilityBill?.expenseAccountId);
    if (
        !settleJournalAlreadyPosted &&
        !settlingViaSalaryPayable &&
        !reclassificationJournalId &&
        expenseAccountId &&
        expenseAccountId !== partyAccountId
    ) {
        try {
            const journal = await createZohoJournal({
                journal_date:
                    clean(body.date || zohoPayment.date) ||
                    new Date().toISOString().slice(0, 10),
                reference_number: clean(
                    body.referenceNumber || zohoPaymentNumber || utilityBillId,
                ) || undefined,
                notes: `Utility deduction reclassification · ${partyAccountCode}`,
                line_items: [
                    {
                        account_id: partyAccountId,
                        amount,
                        debit_or_credit: 'debit',
                        description: `Party account ${partyAccountCode}`,
                    },
                    {
                        account_id: expenseAccountId,
                        amount,
                        debit_or_credit: 'credit',
                        description:
                            clean(utilityBill?.expenseAccountName) ||
                            'Utility expense reclassification',
                    },
                ],
            });
            reclassificationJournalId = clean(
                journal?.journal_id || journal?.journalId || journal?.id,
            );
        } catch (err) {
            console.warn(
                '[PartyExpense] Zoho party-account reclassification failed:',
                err?.message || err,
            );
        }
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
        reclassificationJournalId || clean(body.zohoJournalId, doc.zohoJournalId);
    doc.paidThroughAccountId = paidThroughAccountId;
    doc.paidThroughAccountName = paidThroughAccountName;
    doc.partyAccountId = partyAccountId;
    doc.partyAccountName = partyAccountName;
    doc.partyAccountCode = partyAccountCode;
    doc.paymentMode = clean(body.paymentMode || zohoPayment.payment_mode || doc.paymentMode);
    doc.paidAt = new Date();
    doc.erpPaymentId = clean(body.erpPaymentId || doc.erpPaymentId);
    doc.currencyCode = clean(body.currencyCode || zohoPayment.currency_code, 'AED');

    await doc.save();

    // Do NOT mark utility vendor bill Paid here — that is separate from balance Pay By.

    return {
        expense: doc.toObject(),
        ledgerSource: settlingViaSalaryPayable
            ? 'salary_payable_paid_through'
            : reclassificationJournalId
              ? 'zoho_reclassification'
              : 'party_account_code',
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
        referenceNumber: clean(body.reference_number || body.referenceNumber),
        currencyCode: clean(body.currency_code || zohoPayment.currency_code, 'AED'),
        utilityType: clean(body.utilityType),
        billMonth: clean(body.billMonth),
        utilityBatchId: clean(body.utilityBatchId),
        zohoJournalId: clean(zohoPayment.journal_id || body.zohoJournalId),
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

/**
 * Difference settle in AED via Journal — NOT vendor payment on the (often GBP) bill.
 *
 * After HR Approve (Acc2 Debit · Acc1 Credit), Payments Made posts:
 *   Debit  = Paid Through (cash/bank/selected account)
 *   Credit = Acc2 Salary payable (clears the approve Debit)
 */
export async function settleUtilityDifferenceViaJournal({
    body = {},
    userId = null,
} = {}) {
    const amount = money(body.amount);
    if (amount <= 0) {
        throw Object.assign(new Error('Payment amount must be greater than zero.'), {
            statusCode: 400,
        });
    }

    const list = Array.isArray(body.party_expenses)
        ? body.party_expenses
        : Array.isArray(body.partyExpenses)
          ? body.partyExpenses
          : [];
    const first = list[0] || {};
    const utilityBillId = clean(first.utilityBillId || body.utilityBillId);

    const utilityBill = utilityBillId
        ? await UtilityBillPayment.findById(utilityBillId)
              .select(
                  'partyAccountId partyAccountName partyAccountCode expenseAccountId expenseAccountName zohoOrganizationId billNumber accountNo utilityType billMonth',
              )
              .lean()
        : null;

    let partyAccountId = clean(first.partyAccountId || utilityBill?.partyAccountId);
    let partyAccountName = clean(
        first.partyAccountName || utilityBill?.partyAccountName,
        'Salary payable',
    );
    const partyAccountCode = clean(
        first.partyAccountCode || utilityBill?.partyAccountCode,
    );

    const paidThroughAccountId = clean(
        body.paid_through_account_id || body.paidThroughAccountId,
    );
    const paidThroughAccountName = clean(
        body.paid_through_account_name || body.paidThroughAccountName,
        'Paid Through',
    );

    if (!partyAccountId) {
        throw Object.assign(
            new Error(
                'Employee salary payable account is missing. Re-open the utility bill and retry.',
            ),
            { statusCode: 400 },
        );
    }
    if (!paidThroughAccountId) {
        throw Object.assign(new Error('Paid Through account is required.'), { statusCode: 400 });
    }
    // Debit Paid Through · Credit Acc2 — accounts must differ.
    if (paidThroughAccountId === partyAccountId) {
        throw Object.assign(
            new Error(
                `Paid Through cannot be the same as Acc2 (${partyAccountName || 'Salary payable'}). ` +
                    'Pick Cash / Bank (or another account) — Payments Made Debits Paid Through and Credits Acc2.',
            ),
            { statusCode: 400 },
        );
    }

    const journalDate =
        clean(body.date) || new Date().toISOString().slice(0, 10);
    const reference = clean(
        body.reference_number ||
            body.referenceNumber ||
            utilityBill?.billNumber ||
            utilityBill?.accountNo ||
            utilityBillId,
    );

    const journal = await createZohoJournal({
        journal_date: journalDate,
        reference_number: reference || undefined,
        notes:
            clean(body.description || body.notes) ||
            `Utility difference settle · ${clean(utilityBill?.utilityType)} ${clean(utilityBill?.billMonth)} · Debit ${paidThroughAccountName} · Credit ${partyAccountName}`,
        line_items: [
            {
                account_id: paidThroughAccountId,
                amount,
                debit_or_credit: 'debit',
                description: paidThroughAccountName || 'Paid Through',
            },
            {
                account_id: partyAccountId,
                amount,
                debit_or_credit: 'credit',
                description: partyAccountName || partyAccountCode || 'Salary payable (Acc2)',
            },
        ],
    });

    const journalId = clean(journal?.journal_id || journal?.journalId || journal?.id);
    if (!journalId) {
        throw new Error('Zoho journal created but no journal id returned.');
    }

    const zohoPaymentStub = {
        journal_id: journalId,
        payment_id: journalId,
        payment_number: reference || journalId,
        date: journalDate,
        paid_through_account_id: paidThroughAccountId,
        paid_through_account_name: paidThroughAccountName,
        currency_code: 'AED',
    };

    const partyExpenseResults = await recordPartyExpensesFromVendorPaymentBody({
        body: {
            ...body,
            mode: 'difference',
            paid_through_account_id: paidThroughAccountId,
            paid_through_account_name: paidThroughAccountName,
            zohoJournalId: journalId,
            party_expenses: list.length
                ? list.map((row) => ({
                      ...row,
                      partyAccountId: row.partyAccountId || partyAccountId,
                      partyAccountName: row.partyAccountName || partyAccountName,
                      partyAccountCode: row.partyAccountCode || partyAccountCode,
                  }))
                : [
                      {
                          ...first,
                          partyAccountId,
                          partyAccountName,
                          partyAccountCode,
                          amount,
                          utilityBillId,
                      },
                  ],
        },
        zohoPayment: zohoPaymentStub,
        userId,
    });

    return {
        journalId,
        journal,
        settleViaSalaryPayable: false,
        partyAccountId,
        partyAccountName,
        debitAccountId: paidThroughAccountId,
        debitAccountName: paidThroughAccountName,
        amount,
        partyExpenseResults,
    };
}
