import PartyExpense from '../../models/PartyExpense.js';
import UtilityBillPayment from '../../models/UtilityBillPayment.js';
import Company from '../../models/Company.js';
import {
    recordPartyExpensePaidFromZoho,
} from '../../utils/recordPartyExpenseFromZohoPayment.js';
import { employeeIdQueryVariants } from '../../utils/upsertUtilityBalancePartyExpense.js';

function clean(value, fallback = '') {
    const text = String(value ?? '').trim();
    return text || fallback;
}

function money(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function billHref(bill) {
    const entryId = clean(bill?.entryId);
    const billId = clean(bill?._id || bill?.id);
    if (!entryId) return '/HRM/Asset/UtilityBills';
    if (billId) {
        return `/HRM/Asset/UtilityBills/details/${encodeURIComponent(entryId)}?billId=${encodeURIComponent(billId)}`;
    }
    return `/HRM/Asset/UtilityBills/details/${encodeURIComponent(entryId)}`;
}

/**
 * Over-contract balance owed by Pay By party (not the full vendor bill).
 * Contract − Actual < 0 ⇒ bill higher than contract ⇒ abs(diff) is balance due.
 */
function resolveBalanceShare(bill, { forEmployee = false } = {}) {
    const actual = money(bill?.amount);
    const contract = money(bill?.monthlyRental);
    const signedDiff = Number.isFinite(Number(bill?.differenceAmount))
        ? Number(bill.differenceAmount)
        : contract - actual;
    const overContract = Math.max(0, -signedDiff, Math.abs(Math.min(0, signedDiff)));
    if (overContract <= 0) return 0;
    const empDiff = Number(bill?.employeeDiffAmount);
    const coDiff = Number(bill?.companyDiffAmount);
    const payBy = clean(bill?.paymentBy).toLowerCase();
    if (forEmployee) {
        if (Number.isFinite(empDiff) && empDiff > 0) return money(empDiff);
        if (payBy === 'employee' || payBy === 'employee_balance') {
            return overContract > 0 ? overContract : money(bill?.employeePayAmount);
        }
        if (payBy === 'employee_and_company') {
            return Number.isFinite(empDiff) && empDiff > 0
                ? money(empDiff)
                : money(bill?.employeePayAmount) > 0
                  ? Math.min(overContract, money(bill.employeePayAmount))
                  : 0;
        }
        return 0;
    }
    if (Number.isFinite(coDiff) && coDiff > 0) return money(coDiff);
    if (payBy === 'company') {
        return overContract > 0 ? overContract : money(bill?.companyPayAmount);
    }
    if (payBy === 'employee_and_company') {
        return Number.isFinite(coDiff) && coDiff > 0
            ? money(coDiff)
            : money(bill?.companyPayAmount) > 0
              ? Math.min(overContract, money(bill.companyPayAmount))
              : 0;
    }
    return 0;
}

/** Party's Payable-to share from zoho line items (or bill-level totals). */
function resolvePayableShare(bill, { forEmployee = false, partyVariants = [] } = {}) {
    const variants = new Set((partyVariants || []).map((v) => String(v).trim()).filter(Boolean));
    const lines = Array.isArray(bill?.zohoLineItems) ? bill.zohoLineItems : [];
    let fromLines = 0;
    let matchedLine = false;

    lines.forEach((line) => {
        const amt = money(line?.amount);
        if (amt <= 0) return;
        const empId = clean(line?.payByEmployeeId);
        const coId = clean(line?.payByCompanyId);
        const payBy = clean(line?.payBy).toLowerCase();
        const isEmployeeLine =
            payBy === 'employee' || Boolean(empId && payBy !== 'company');
        const isCompanyLine =
            !isEmployeeLine && (payBy === 'company' || Boolean(coId));

        if (forEmployee) {
            if (!isEmployeeLine) return;
            if (variants.size && empId && !variants.has(empId)) return;
            if (!empId && variants.size) return;
            matchedLine = true;
            fromLines += amt;
            return;
        }
        if (!isCompanyLine) return;
        if (variants.size && coId && !variants.has(coId)) return;
        if (!coId && variants.size) return;
        matchedLine = true;
        fromLines += amt;
    });

    if (matchedLine) return fromLines;

    if (forEmployee) {
        const empId = clean(bill?.payByEmployeeId);
        if (variants.size && empId && !variants.has(empId)) return 0;
        return money(bill?.employeePayAmount);
    }
    const coId = clean(bill?.payByCompanyId);
    if (variants.size && coId && !variants.has(coId)) return 0;
    return money(bill?.companyPayAmount);
}

function billMatchesParty(bill, { employeeVariants = [], companyVariants = [] } = {}) {
    const empSet = new Set(employeeVariants.map(String));
    const coSet = new Set(companyVariants.map(String));
    if (empSet.size) {
        if (empSet.has(clean(bill?.payByEmployeeId))) return true;
        return (Array.isArray(bill?.zohoLineItems) ? bill.zohoLineItems : []).some((line) =>
            empSet.has(clean(line?.payByEmployeeId)),
        );
    }
    if (coSet.size) {
        if (coSet.has(clean(bill?.payByCompanyId))) return true;
        return (Array.isArray(bill?.zohoLineItems) ? bill.zohoLineItems : []).some((line) => {
            const payBy = clean(line?.payBy).toLowerCase();
            const empId = clean(line?.payByEmployeeId);
            const isEmployeeLine =
                payBy === 'employee' || Boolean(empId && payBy !== 'company');
            if (isEmployeeLine) return false;
            return coSet.has(clean(line?.payByCompanyId));
        });
    }
    return false;
}

function paymentHref(expense) {
    const zohoId = clean(expense?.zohoPaymentId);
    if (zohoId) {
        const org = clean(expense?.zohoOrganizationId);
        const qs = org ? `?organizationId=${encodeURIComponent(org)}` : '';
        return `/Accounts/PaymentsMade/${encodeURIComponent(zohoId)}${qs}`;
    }
    const erpId = clean(expense?.erpPaymentId);
    if (erpId) return `/Accounts/Payments?paymentId=${encodeURIComponent(erpId)}`;
    return '/Accounts/PaymentsMade';
}

function fineHref(fineMongoId, fineId) {
    const id = clean(fineId || fineMongoId);
    if (!id) return '/HRM/Fine';
    return `/HRM/Fine/${encodeURIComponent(id)}`;
}

/**
 * Expense status Paid when PartyExpense is Paid after Zoho Save as Paid (debit/credit ledger).
 */
export async function listPartyExpenses(req, res) {
    try {
        const employeeId = clean(req.query.employeeId);
        const companyId = clean(req.query.companyId);

        if (!employeeId && !companyId) {
            return res.status(400).json({ message: 'employeeId or companyId is required.' });
        }

        const employeeVariants = employeeId
            ? await employeeIdQueryVariants(employeeId)
            : [];
        const companyVariants = companyId
            ? await (async () => {
                  const ids = new Set([companyId]);
                  const query = /^[0-9a-fA-F]{24}$/.test(companyId)
                      ? { _id: companyId }
                      : { companyId };
                  const company = await Company.findOne(query).select('_id companyId').lean();
                  if (company?._id) ids.add(String(company._id));
                  if (company?.companyId) ids.add(String(company.companyId));
                  return [...ids];
              })()
            : [];

        const expenseFilter = employeeId
            ? {
                  partyType: 'employee',
                  employeeId: { $in: employeeVariants.length ? employeeVariants : [employeeId] },
              }
            : {
                  partyType: 'company',
                  companyId: { $in: companyVariants.length ? companyVariants : [companyId] },
              };

        const billPartyFilter = employeeId
            ? {
                  $or: [
                      {
                          payByEmployeeId: {
                              $in: employeeVariants.length ? employeeVariants : [employeeId],
                          },
                      },
                      {
                          'zohoLineItems.payByEmployeeId': {
                              $in: employeeVariants.length ? employeeVariants : [employeeId],
                          },
                      },
                  ],
                  status: { $in: ['Approved', 'Paid', 'Pending HR', 'Pending Accounts'] },
              }
            : {
                  $or: [
                      {
                          payByCompanyId: {
                              $in: companyVariants.length ? companyVariants : [companyId],
                          },
                      },
                      {
                          'zohoLineItems.payByCompanyId': {
                              $in: companyVariants.length ? companyVariants : [companyId],
                          },
                      },
                  ],
                  status: { $in: ['Approved', 'Paid', 'Pending HR', 'Pending Accounts'] },
              };

        const [stored, billsRaw] = await Promise.all([
            PartyExpense.find({
                ...expenseFilter,
                kind: { $in: ['balance', 'other', 'fine', 'loan', 'advance'] },
            })
                .sort({ updatedAt: -1 })
                .lean(),
            UtilityBillPayment.find(billPartyFilter).sort({ createdAt: -1 }).lean(),
        ]);

        const bills = (billsRaw || []).filter((bill) =>
            billMatchesParty(bill, {
                employeeVariants: employeeId ? employeeVariants : [],
                companyVariants: companyId ? companyVariants : [],
            }),
        );

        const byBillId = new Map(
            stored
                .filter((e) => clean(e.utilityBillId) && clean(e.kind || 'balance') === 'balance')
                .map((e) => [clean(e.utilityBillId), e]),
        );

        const rows = [];
        const seenBills = new Set();
        const partyVariants = employeeId
            ? employeeVariants.length
                ? employeeVariants
                : [employeeId]
            : companyVariants.length
              ? companyVariants
              : [companyId];

        for (const bill of bills) {
            const billId = clean(bill._id);
            if (!billId) continue;

            const payableShare = resolvePayableShare(bill, {
                forEmployee: Boolean(employeeId),
                partyVariants,
            });
            const balanceShare = employeeId
                ? resolveBalanceShare(bill, { forEmployee: true })
                : resolveBalanceShare(bill, { forEmployee: false });

            const expense = byBillId.get(billId);
            const vendorPaid = clean(bill.status).toLowerCase() === 'paid';
            const balancePaid = expense?.status === 'Paid';

            if (payableShare > 0) {
                rows.push({
                    id: `share:${billId}`,
                    partyType: employeeId ? 'employee' : 'company',
                    kind: 'utility_share',
                    status: vendorPaid ? 'Paid' : 'Not Paid',
                    amount: payableShare,
                    description:
                        `Utility payable share · ${clean(bill.utilityType)} ${clean(bill.billMonth)} · Acc ${clean(bill.accountNo)}`.trim(),
                    utilityBillId: billId,
                    utilityBatchId: clean(bill.batchId || expense?.utilityBatchId),
                    accountNo: clean(bill.accountNo || expense?.accountNo),
                    utilityType: clean(bill.utilityType || expense?.utilityType),
                    billMonth: clean(bill.billMonth || expense?.billMonth),
                    entryId: clean(bill.entryId || expense?.entryId),
                    zohoBillId: clean(bill.zohoBillId || expense?.zohoBillId),
                    zohoPaymentId: clean(expense?.zohoPaymentId),
                    zohoPaymentNumber: clean(expense?.zohoPaymentNumber),
                    zohoOrganizationId: clean(expense?.zohoOrganizationId || bill.zohoOrganizationId),
                    zohoJournalId: clean(expense?.zohoJournalId),
                    paidThroughAccountId: clean(expense?.paidThroughAccountId),
                    paidThroughAccountName: clean(expense?.paidThroughAccountName),
                    partyAccountId: clean(bill.partyAccountId),
                    partyAccountName: clean(bill.partyAccountName),
                    partyAccountCode: clean(bill.partyAccountCode),
                    paymentMode: clean(expense?.paymentMode),
                    paidAt: vendorPaid ? bill.updatedAt || bill.createdAt || null : null,
                    ledger: [],
                    billLink: billHref(bill),
                    paymentLink: '',
                    canPay: false,
                    employeeId: clean(expense?.employeeId || bill.payByEmployeeId || employeeId),
                    employeeName: clean(expense?.employeeName || bill.payByEmployeeName),
                    companyId: clean(expense?.companyId || bill.payByCompanyId || companyId),
                    companyName: clean(expense?.companyName || bill.payByCompanyName),
                });
            }

            // No over-contract balance for this party → skip balance row.
            if (balanceShare <= 0) continue;

            seenBills.add(billId);

            rows.push({
                id: expense?._id ? String(expense._id) : `balance:${billId}`,
                partyType: employeeId ? 'employee' : 'company',
                kind: 'balance',
                status: balancePaid ? 'Paid' : 'Not Paid',
                amount: balancePaid && expense?.amount > 0 ? money(expense.amount) : balanceShare,
                description:
                    expense?.description ||
                    `Balance (over contract) · ${clean(bill.utilityType)} ${clean(bill.billMonth)} · Acc ${clean(bill.accountNo)}`.trim(),
                utilityBillId: billId,
                utilityBatchId: clean(bill.batchId || expense?.utilityBatchId),
                accountNo: clean(bill.accountNo || expense?.accountNo),
                utilityType: clean(bill.utilityType || expense?.utilityType),
                billMonth: clean(bill.billMonth || expense?.billMonth),
                entryId: clean(bill.entryId || expense?.entryId),
                zohoBillId: clean(bill.zohoBillId || expense?.zohoBillId),
                zohoPaymentId: clean(expense?.zohoPaymentId),
                zohoPaymentNumber: clean(expense?.zohoPaymentNumber),
                zohoOrganizationId: clean(expense?.zohoOrganizationId || bill.zohoOrganizationId),
                zohoJournalId: clean(expense?.zohoJournalId),
                paidThroughAccountId: clean(expense?.paidThroughAccountId),
                paidThroughAccountName: clean(expense?.paidThroughAccountName),
                partyAccountId: clean(bill.partyAccountId),
                partyAccountName: clean(bill.partyAccountName),
                partyAccountCode: clean(bill.partyAccountCode),
                paymentMode: clean(expense?.paymentMode),
                paidAt: expense?.paidAt || null,
                ledger: Array.isArray(expense?.ledger) ? expense.ledger : [],
                billLink: billHref(bill),
                paymentLink: balancePaid ? paymentHref(expense || {}) : '',
                canPay: !balancePaid,
                employeeId: clean(expense?.employeeId || bill.payByEmployeeId || employeeId),
                employeeName: clean(expense?.employeeName || bill.payByEmployeeName),
                companyId: clean(expense?.companyId || bill.payByCompanyId || companyId),
                companyName: clean(expense?.companyName || bill.payByCompanyName),
            });
        }

        for (const expense of stored) {
            const billId = clean(expense.utilityBillId);
            if (billId && seenBills.has(billId)) continue;
            const kind = clean(expense.kind || 'balance');
            if (kind === 'fine') {
                const isPaid = expense.status === 'Paid';
                rows.push({
                    id: String(expense._id),
                    partyType: expense.partyType,
                    kind: 'fine',
                    status: isPaid ? 'Paid' : 'Not Paid',
                    amount: money(expense.amount),
                    description: expense.description || '',
                    fineMongoId: clean(expense.fineMongoId),
                    fineId: clean(expense.fineId),
                    utilityBillId: '',
                    utilityBatchId: '',
                    accountNo: '',
                    utilityType: '',
                    billMonth: '',
                    entryId: '',
                    zohoBillId: clean(expense.zohoBillId),
                    zohoPaymentId: clean(expense.zohoPaymentId),
                    zohoPaymentNumber: clean(expense.zohoPaymentNumber),
                    zohoOrganizationId: clean(expense.zohoOrganizationId),
                    zohoJournalId: clean(expense.zohoJournalId),
                    paidThroughAccountId: clean(expense.paidThroughAccountId),
                    paidThroughAccountName: clean(expense.paidThroughAccountName),
                    partyAccountId: clean(expense.partyAccountId),
                    partyAccountName: clean(expense.partyAccountName),
                    partyAccountCode: clean(expense.partyAccountCode),
                    paymentMode: clean(expense.paymentMode),
                    paidAt: expense.paidAt || null,
                    ledger: Array.isArray(expense.ledger) ? expense.ledger : [],
                    billLink: fineHref(expense.fineMongoId, expense.fineId),
                    paymentLink: isPaid ? paymentHref(expense) : '',
                    canPay: false,
                    employeeId: clean(expense.employeeId),
                    employeeName: clean(expense.employeeName),
                    companyId: clean(expense.companyId),
                    companyName: clean(expense.companyName),
                });
                continue;
            }
            if (kind === 'loan' || kind === 'advance') {
                const isPaid = expense.status === 'Paid';
                const loanLinkId = clean(expense.loanId || expense.loanMongoId);
                rows.push({
                    id: String(expense._id),
                    partyType: expense.partyType,
                    kind,
                    status: isPaid ? 'Paid' : 'Not Paid',
                    amount: money(expense.amount),
                    description: expense.description || '',
                    loanMongoId: clean(expense.loanMongoId),
                    loanId: clean(expense.loanId),
                    duration: Number(expense.duration) || null,
                    monthStart: clean(expense.monthStart),
                    installments: Array.isArray(expense.installments) ? expense.installments : [],
                    utilityBillId: '',
                    utilityBatchId: '',
                    accountNo: clean(expense.loanId),
                    utilityType: kind === 'advance' ? 'Advance' : 'Loan',
                    billMonth: clean(expense.monthStart),
                    entryId: '',
                    zohoBillId: '',
                    zohoPaymentId: clean(expense.zohoPaymentId),
                    zohoPaymentNumber: clean(expense.zohoPaymentNumber),
                    zohoOrganizationId: clean(expense.zohoOrganizationId),
                    zohoJournalId: clean(expense.zohoJournalId),
                    paidThroughAccountId: clean(expense.paidThroughAccountId),
                    paidThroughAccountName: clean(expense.paidThroughAccountName),
                    paymentMode: clean(expense.paymentMode),
                    paidAt: expense.paidAt || null,
                    ledger: Array.isArray(expense.ledger) ? expense.ledger : [],
                    billLink: loanLinkId
                        ? `/HRM/LoanAndAdvance/${encodeURIComponent(loanLinkId)}`
                        : '/HRM/LoanAndAdvance',
                    paymentLink: isPaid ? paymentHref(expense) : '',
                    canPay: false,
                    employeeId: clean(expense.employeeId),
                    employeeName: clean(expense.employeeName),
                    companyId: clean(expense.companyId),
                    companyName: clean(expense.companyName),
                });
                continue;
            }
            if (kind !== 'balance') continue;
            const isPaid = expense.status === 'Paid';
            rows.push({
                id: String(expense._id),
                partyType: expense.partyType,
                kind: 'balance',
                status: isPaid ? 'Paid' : 'Not Paid',
                amount: money(expense.amount),
                description: expense.description || '',
                utilityBillId: billId,
                utilityBatchId: clean(expense.utilityBatchId),
                accountNo: clean(expense.accountNo),
                utilityType: clean(expense.utilityType),
                billMonth: clean(expense.billMonth),
                entryId: clean(expense.entryId),
                zohoBillId: clean(expense.zohoBillId),
                zohoPaymentId: clean(expense.zohoPaymentId),
                zohoPaymentNumber: clean(expense.zohoPaymentNumber),
                zohoOrganizationId: clean(expense.zohoOrganizationId),
                zohoJournalId: clean(expense.zohoJournalId),
                paidThroughAccountId: clean(expense.paidThroughAccountId),
                paidThroughAccountName: clean(expense.paidThroughAccountName),
                partyAccountId: clean(expense.partyAccountId),
                partyAccountName: clean(expense.partyAccountName),
                partyAccountCode: clean(expense.partyAccountCode),
                paymentMode: clean(expense.paymentMode),
                paidAt: expense.paidAt || null,
                ledger: Array.isArray(expense.ledger) ? expense.ledger : [],
                billLink: expense.entryId
                    ? billHref({ entryId: expense.entryId, _id: expense.utilityBillId })
                    : '/HRM/Asset/UtilityBills',
                paymentLink: isPaid ? paymentHref(expense) : '',
                canPay: !isPaid,
                employeeId: clean(expense.employeeId),
                employeeName: clean(expense.employeeName),
                companyId: clean(expense.companyId),
                companyName: clean(expense.companyName),
            });
        }

        rows.sort((a, b) => {
            if (a.status !== b.status) return a.status === 'Not Paid' ? -1 : 1;
            return String(b.billMonth || '').localeCompare(String(a.billMonth || ''));
        });

        return res.status(200).json({ success: true, rows });
    } catch (err) {
        console.error('[listPartyExpenses]', err);
        return res.status(500).json({ message: err.message || 'Failed to load expenses.' });
    }
}

/**
 * POST /api/Expense/from-vendor-payment
 * Marks expense Paid and stores Zoho debit/credit ledger (credit locked).
 */
export async function upsertPartyExpenseFromVendorPayment(req, res) {
    try {
        const recorded = await recordPartyExpensePaidFromZoho({
            body: req.body || {},
            zohoPayment: req.body?.zohoPayment || {},
            userId: req.user?._id || null,
        });

        return res.status(201).json({
            success: true,
            expense: recorded.expense,
            ledgerSource: recorded.ledgerSource,
            journalId: recorded.journalId,
            message:
                'Expense marked Paid. Zoho debit/credit ledger stored (credit is permanent).',
        });
    } catch (err) {
        console.error('[upsertPartyExpenseFromVendorPayment]', err);
        const message = err.message || 'Failed to store party expense.';
        const isValidation = /required|greater than/i.test(message);
        return res.status(isValidation ? 400 : 500).json({ message });
    }
}
