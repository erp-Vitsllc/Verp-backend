import PartyExpense from '../models/PartyExpense.js';
import EmployeeBasic from '../models/EmployeeBasic.js';

function clean(value, fallback = '') {
    const text = String(value ?? '').trim();
    return text || fallback;
}

function money(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

/**
 * Resolve business employeeId (VEGA-HR-…) from Mongo _id or already-business id.
 */
export async function resolveBusinessEmployeeId(payByEmployeeId) {
    const raw = clean(payByEmployeeId);
    if (!raw) return '';
    if (!/^[0-9a-fA-F]{24}$/.test(raw)) return raw;

    const emp = await EmployeeBasic.findById(raw).select('employeeId').lean();
    return clean(emp?.employeeId, raw);
}

/** Employee + Mongo id variants for querying payByEmployeeId / PartyExpense.employeeId. */
export async function employeeIdQueryVariants(employeeId) {
    const raw = clean(employeeId);
    if (!raw) return [];

    const ids = new Set([raw]);
    const emp = await EmployeeBasic.findOne({
        $or: [
            { employeeId: raw },
            ...(/^[0-9a-fA-F]{24}$/.test(raw) ? [{ _id: raw }] : []),
        ],
    })
        .select('_id employeeId')
        .lean();

    if (emp) {
        ids.add(String(emp._id));
        ids.add(clean(emp.employeeId));
    }
    return [...ids].filter(Boolean);
}

function employeeBalanceAmount(bill) {
    const empDiff = Number(bill?.employeeDiffAmount);
    if (Number.isFinite(empDiff) && empDiff > 0) return money(empDiff);

    const payBy = clean(bill?.paymentBy).toLowerCase();
    const empPay = money(bill?.employeePayAmount);
    if (payBy === 'employee' || payBy === 'employee_balance' || payBy === 'employee_and_company') {
        if (empPay > 0) return empPay;
    }

    const actual = money(bill?.amount);
    const contract = money(bill?.monthlyRental);
    const overContract = Math.max(0, actual - contract);
    if (
        (payBy === 'employee' || payBy === 'employee_balance') &&
        overContract > 0
    ) {
        return overContract;
    }
    return 0;
}

/**
 * After HR approve: upsert Not Paid PartyExpense balance rows so employee profile Expenses lists them.
 */
export async function upsertUtilityBalancePartyExpensesFromBills(bills = [], userId = null) {
    const results = [];
    for (const bill of bills || []) {
        const amount = employeeBalanceAmount(bill);
        if (amount <= 0) continue;

        const utilityBillId = clean(bill?._id || bill?.id);
        if (!utilityBillId) continue;

        const businessEmployeeId = await resolveBusinessEmployeeId(bill.payByEmployeeId);
        if (!businessEmployeeId) continue;

        let doc = await PartyExpense.findOne({
            utilityBillId,
            kind: 'balance',
            partyType: 'employee',
            employeeId: businessEmployeeId,
        });

        if (!doc) {
            doc = new PartyExpense({
                partyType: 'employee',
                kind: 'balance',
                employeeId: businessEmployeeId,
                employeeName: clean(bill.payByEmployeeName),
                utilityBillId,
                status: 'Not Paid',
                createdBy: userId || null,
                ledger: [],
            });
        }

        // Do not overwrite Paid rows from a later approve/retry.
        if (doc.status === 'Paid') {
            results.push({ ok: true, skipped: true, expenseId: String(doc._id) });
            continue;
        }

        doc.status = 'Not Paid';
        doc.amount = amount;
        doc.employeeName = clean(bill.payByEmployeeName, doc.employeeName);
        doc.utilityBatchId = clean(bill.batchId, doc.utilityBatchId);
        doc.accountNo = clean(bill.accountNo, doc.accountNo);
        doc.utilityType = clean(bill.utilityType, doc.utilityType);
        doc.billMonth = clean(bill.billMonth, doc.billMonth);
        doc.entryId = clean(bill.entryId, doc.entryId);
        doc.zohoBillId = clean(bill.zohoBillId, doc.zohoBillId);
        doc.zohoOrganizationId = clean(bill.zohoOrganizationId, doc.zohoOrganizationId);
        doc.description = clean(
            `Balance (over contract) · ${clean(bill.utilityType)} ${clean(bill.billMonth)} · Acc ${clean(bill.accountNo)}`,
        );
        await doc.save();
        results.push({ ok: true, expenseId: String(doc._id), amount });
    }
    return results;
}

/**
 * Mark utility balance PartyExpense Paid after Accounts → Payments (employee credit / Zoho journal).
 */
export async function markUtilityBalancePartyExpensePaid({
    utilityBillId = '',
    employeeId = '',
    amount = 0,
    payment = null,
    zohoResult = {},
    expenseAccountId = '',
    expenseAccountName = '',
    paidThroughAccountId = '',
    paidThroughAccountName = '',
    userId = null,
} = {}) {
    const billId = clean(utilityBillId);
    const businessEmployeeId = await resolveBusinessEmployeeId(employeeId);
    if (!billId || !businessEmployeeId) {
        return { ok: false, message: 'utilityBillId and employeeId are required.' };
    }

    let doc = await PartyExpense.findOne({
        utilityBillId: billId,
        kind: 'balance',
        partyType: 'employee',
        employeeId: businessEmployeeId,
    });

    if (!doc) {
        doc = new PartyExpense({
            partyType: 'employee',
            kind: 'balance',
            employeeId: businessEmployeeId,
            utilityBillId: billId,
            createdBy: userId || null,
            ledger: [],
        });
    }

    const payAmt = money(amount || payment?.amount || doc.amount);
    const creditId = clean(paidThroughAccountId || payment?.paidThroughAccountId);
    const creditName = clean(paidThroughAccountName || payment?.paidThroughAccountName, 'Paid Through');
    const debitId = clean(expenseAccountId || payment?.expenseAccountId);
    const debitName = clean(expenseAccountName || payment?.expenseAccountName, 'Expense');

    if (payAmt > 0 && creditId && debitId) {
        const already = (doc.ledger || []).some(
            (row) =>
                row.locked &&
                String(row.accountId) === creditId &&
                row.side === 'credit' &&
                Number(row.amount) === payAmt,
        );
        if (!already) {
            doc.ledger.push(
                {
                    side: 'debit',
                    accountId: debitId,
                    accountName: debitName,
                    amount: payAmt,
                    notes: 'Debit (expense)',
                    locked: true,
                    createdAt: new Date(),
                },
                {
                    side: 'credit',
                    accountId: creditId,
                    accountName: creditName,
                    amount: payAmt,
                    notes: 'Credit (Paid Through)',
                    locked: true,
                    createdAt: new Date(),
                },
            );
        }
    }

    doc.status = 'Paid';
    doc.amount = payAmt > 0 ? payAmt : doc.amount;
    doc.zohoOrganizationId = clean(
        zohoResult.organizationId || payment?.zohoOrganizationId,
        doc.zohoOrganizationId,
    );
    doc.zohoJournalId = clean(zohoResult.journalId || payment?.zohoJournalId, doc.zohoJournalId);
    doc.paidThroughAccountId = creditId || doc.paidThroughAccountId;
    doc.paidThroughAccountName = creditName || doc.paidThroughAccountName;
    doc.paidAt = new Date();
    doc.erpPaymentId = clean(payment?._id, doc.erpPaymentId);
    doc.paymentMode = clean(payment?.paymentSource, doc.paymentMode);
    await doc.save();

    return { ok: true, expense: doc.toObject() };
}
