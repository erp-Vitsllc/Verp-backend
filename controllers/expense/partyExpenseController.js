import mongoose from 'mongoose';
import PartyExpense from '../../models/PartyExpense.js';
import UtilityBillPayment from '../../models/UtilityBillPayment.js';
import Company from '../../models/Company.js';
import Fine from '../../models/Fine.js';
import ZohoBill from '../../models/ZohoBill.js';
import AssetItem from '../../models/AssetItem.js';
import {
    recordPartyExpensePaidFromZoho,
} from '../../utils/recordPartyExpenseFromZohoPayment.js';
import { employeeIdQueryVariants } from '../../utils/upsertUtilityBalancePartyExpense.js';
import { isZohoBillFullyPaid } from '../../utils/markUtilityVendorBillsPaidFromZoho.js';

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

/** Company rows: Zoho billed (no Pay deduction). Employee rows: Not Paid until deduction is paid. */
function partyRowStatus({ paid, zohoBillId, forEmployee }) {
    if (paid) return 'Paid';
    if (!forEmployee && clean(zohoBillId)) return 'Zoho billed';
    return 'Not Paid';
}

function parseJsonRemark(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function collectRemarkZohoBillIds(remark = {}) {
    const ids = [];
    const push = (value) => {
        const id = clean(value);
        if (id) ids.push(id);
    };
    push(remark.zohoBillId);
    for (const row of Array.isArray(remark.zohoBills) ? remark.zohoBills : []) {
        push(row?.zohoBillId || row?.bill_id || row?.billId);
    }
    return ids;
}

function remarkServiceIsPaid(remark = {}, paidZohoIds = new Set()) {
    const zohoPaymentStatus = clean(remark.zohoPaymentStatus).toLowerCase();
    const zohoBillStatus = clean(remark.zohoBillStatus).toLowerCase();
    const carWashPay = clean(remark.carWashPaymentStatus).toLowerCase();
    const billingStatus = clean(remark.billingStatus).toLowerCase();
    if (
        zohoPaymentStatus === 'paid' ||
        zohoBillStatus === 'paid' ||
        carWashPay === 'paid' ||
        billingStatus === 'paid'
    ) {
        return true;
    }
    const ids = collectRemarkZohoBillIds(remark);
    if (ids.some((id) => paidZohoIds.has(id))) return true;
    const multi = Array.isArray(remark.zohoBills) ? remark.zohoBills.filter(Boolean) : [];
    if (multi.length > 0) {
        return multi.every(
            (row) => clean(row?.zohoBillStatus || row?.status).toLowerCase() === 'paid',
        );
    }
    return false;
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

function lineIsEmployeePayable(line = {}) {
    const payBy = clean(line?.payBy).toLowerCase();
    const empId = clean(line?.payByEmployeeId);
    return payBy === 'employee' || Boolean(empId && payBy !== 'company');
}

function lineIsCompanyPayable(line = {}) {
    if (lineIsEmployeePayable(line)) return false;
    const payBy = clean(line?.payBy).toLowerCase();
    const coId = clean(line?.payByCompanyId);
    const coName = clean(line?.payByCompanyName);
    return payBy === 'company' || Boolean(coId || coName);
}

function partyNameSet(names = []) {
    return new Set(
        (names || [])
            .map((v) =>
                String(v || '')
                    .trim()
                    .toLowerCase()
                    .replace(/\s*\([^)]*\)\s*$/g, '')
                    .trim(),
            )
            .filter(Boolean),
    );
}

function namesMatch(value, nameSet) {
    if (!nameSet.size) return false;
    const n = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s*\([^)]*\)\s*$/g, '')
        .trim();
    if (!n) return false;
    if (nameSet.has(n)) return true;
    for (const name of nameSet) {
        if (name && (n.includes(name) || name.includes(n))) return true;
    }
    return false;
}

/**
 * Party's Payable-to share from zoho line items.
 * Same company (or employee) on two lines of one bill → one amount (those
 * payable lines added together). Never the full bill total.
 */
function resolvePayableShare(
    bill,
    { forEmployee = false, partyVariants = [], partyNames = [] } = {},
) {
    const variants = new Set((partyVariants || []).map((v) => String(v).trim()).filter(Boolean));
    const names = partyNameSet(partyNames);
    const lines = Array.isArray(bill?.zohoLineItems) ? bill.zohoLineItems : [];
    const grouped = new Map();

    const matchesParty = (id, name) => {
        if (id && variants.size && variants.has(id)) return true;
        if (name && namesMatch(name, names)) return true;
        if (!variants.size && !names.size) return Boolean(id || name);
        return false;
    };

    lines.forEach((line) => {
        const amt = money(line?.amount);
        if (amt <= 0) return;
        if (forEmployee) {
            if (!lineIsEmployeePayable(line)) return;
            const empId = clean(line?.payByEmployeeId);
            const empName = clean(line?.payByEmployeeName);
            if (!matchesParty(empId, empName)) return;
            const key = `employee:${empId || empName.toLowerCase()}`;
            grouped.set(key, (grouped.get(key) || 0) + amt);
            return;
        }
        if (!lineIsCompanyPayable(line)) return;
        const coId = clean(line?.payByCompanyId);
        const coName = clean(line?.payByCompanyName);
        if (!matchesParty(coId, coName)) return;
        const key = `company:${coId || coName.toLowerCase()}`;
        grouped.set(key, (grouped.get(key) || 0) + amt);
    });

    if (grouped.size) {
        return money([...grouped.values()].reduce((sum, n) => sum + n, 0));
    }

    // Lines exist but none belong to this party — do not fall back to bill total.
    if (lines.length) return 0;

    if (forEmployee) {
        const empId = clean(bill?.payByEmployeeId);
        const empName = clean(bill?.payByEmployeeName);
        if (variants.size || names.size) {
            if (!matchesParty(empId, empName)) return 0;
        }
        return money(bill?.employeePayAmount);
    }
    const coId = clean(bill?.payByCompanyId);
    const coName = clean(bill?.payByCompanyName);
    if (variants.size || names.size) {
        if (!matchesParty(coId, coName)) return 0;
    }
    return money(bill?.companyPayAmount);
}

function billMatchesParty(bill, { employeeVariants = [], companyVariants = [], companyNames = [] } = {}) {
    const empSet = new Set(employeeVariants.map(String));
    const coSet = new Set(companyVariants.map(String));
    const nameSet = partyNameSet(companyNames);
    if (empSet.size) {
        if (empSet.has(clean(bill?.payByEmployeeId))) return true;
        return (Array.isArray(bill?.zohoLineItems) ? bill.zohoLineItems : []).some((line) =>
            empSet.has(clean(line?.payByEmployeeId)),
        );
    }
    if (coSet.size || nameSet.size) {
        const billCoId = clean(bill?.payByCompanyId);
        const billCoName = clean(bill?.payByCompanyName);
        if (billCoId && coSet.has(billCoId)) return true;
        if (namesMatch(billCoName, nameSet)) return true;
        return (Array.isArray(bill?.zohoLineItems) ? bill.zohoLineItems : []).some((line) => {
            if (lineIsEmployeePayable(line)) return false;
            const coId = clean(line?.payByCompanyId);
            const coName = clean(line?.payByCompanyName);
            if (coId && coSet.has(coId)) return true;
            return namesMatch(coName, nameSet);
        });
    }
    return false;
}

function collapseSameBillPayableRows(rows = []) {
    const out = [];
    const shareIndex = new Map();
    for (const row of rows) {
        const kind = clean(row?.kind);
        const billId = clean(row?.utilityBillId);
        const month = clean(row?.billMonth);
        if (kind !== 'utility_share' || !billId) {
            out.push(row);
            continue;
        }
        const party = clean(row?.companyId || row?.employeeId);
        const key = `${billId}|${month}|${party}|${clean(row?.partyType)}`;
        const existing = shareIndex.get(key);
        if (existing == null) {
            shareIndex.set(key, out.length);
            out.push({ ...row });
            continue;
        }
        const prev = out[existing];
        prev.amount = money((Number(prev.amount) || 0) + (Number(row.amount) || 0));
    }
    return out;
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
        const companyNames = [];
        const companyVariants = companyId
            ? await (async () => {
                  const ids = new Set([companyId]);
                  const query = /^[0-9a-fA-F]{24}$/.test(companyId)
                      ? { _id: companyId }
                      : { companyId };
                  const company = await Company.findOne(query)
                      .select('_id companyId name nickName')
                      .lean();
                  if (company?._id) ids.add(String(company._id));
                  if (company?.companyId) ids.add(String(company.companyId));
                  if (company?.name) companyNames.push(String(company.name).trim());
                  if (company?.nickName) companyNames.push(String(company.nickName).trim());
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
                companyNames: companyId ? companyNames : [],
            }),
        );

        const isCompanyList = Boolean(companyId) && !employeeId;
        const paidZohoIds = new Set();
        const paidFineMongoIds = new Set();
        if (isCompanyList) {
            const zohoIds = new Set();
            for (const bill of bills) {
                const id = clean(bill.zohoBillId);
                if (id) zohoIds.add(id);
            }
            for (const expense of stored) {
                const id = clean(expense.zohoBillId);
                if (id) zohoIds.add(id);
            }
            if (zohoIds.size) {
                const cached = await ZohoBill.find({ zohoBillId: { $in: [...zohoIds] } })
                    .select('zohoBillId status balance total')
                    .lean();
                for (const zb of cached) {
                    if (isZohoBillFullyPaid(zb)) paidZohoIds.add(clean(zb.zohoBillId));
                }
            }
            const fineMongoIds = stored
                .filter((e) => clean(e.kind) === 'fine' && clean(e.fineMongoId))
                .map((e) => clean(e.fineMongoId));
            if (fineMongoIds.length) {
                const oids = fineMongoIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
                if (oids.length) {
                    const fines = await Fine.find({ _id: { $in: oids } })
                        .select('_id vendorBillStatus zohoBillId')
                        .lean();
                    for (const f of fines) {
                        if (clean(f.vendorBillStatus).toLowerCase() === 'paid') {
                            paidFineMongoIds.add(String(f._id));
                        }
                        if (paidZohoIds.has(clean(f.zohoBillId))) {
                            paidFineMongoIds.add(String(f._id));
                        }
                    }
                }
            }
        }

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
        const partyNames = employeeId ? [] : companyNames;

        for (const bill of bills) {
            const billId = clean(bill._id);
            if (!billId) continue;

            const payableShare = resolvePayableShare(bill, {
                forEmployee: Boolean(employeeId),
                partyVariants,
                partyNames,
            });
            const balanceShare = employeeId
                ? resolveBalanceShare(bill, { forEmployee: true })
                : resolveBalanceShare(bill, { forEmployee: false });

            const expense = byBillId.get(billId);
            const zohoBillId = clean(bill.zohoBillId || expense?.zohoBillId);
            const vendorPaid =
                clean(bill.status).toLowerCase() === 'paid' ||
                (isCompanyList && paidZohoIds.has(zohoBillId));
            const balancePaid = expense?.status === 'Paid';
            const forEmployee = Boolean(employeeId);

            if (payableShare > 0) {
                seenBills.add(billId);
                rows.push({
                    id: `share:${billId}`,
                    partyType: forEmployee ? 'employee' : 'company',
                    kind: 'utility_share',
                    status: partyRowStatus({
                        paid: vendorPaid,
                        zohoBillId,
                        forEmployee,
                    }),
                    amount: payableShare,
                    description:
                        `Utility payable share · ${clean(bill.utilityType)} ${clean(bill.billMonth)} · Acc ${clean(bill.accountNo)}`.trim(),
                    utilityBillId: billId,
                    utilityBatchId: clean(bill.batchId || expense?.utilityBatchId),
                    accountNo: clean(bill.accountNo || expense?.accountNo),
                    utilityType: clean(bill.utilityType || expense?.utilityType),
                    billMonth: clean(bill.billMonth || expense?.billMonth),
                    entryId: clean(bill.entryId || expense?.entryId),
                    zohoBillId,
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
                partyType: forEmployee ? 'employee' : 'company',
                kind: 'balance',
                status: partyRowStatus({
                    paid: balancePaid,
                    zohoBillId,
                    forEmployee,
                }),
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
                zohoBillId,
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
                canPay: forEmployee && !balancePaid,
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
                const isPaid =
                    expense.status === 'Paid' ||
                    (isCompanyList &&
                        (Boolean(clean(expense.zohoPaymentId)) ||
                            paidFineMongoIds.has(clean(expense.fineMongoId)) ||
                            paidZohoIds.has(clean(expense.zohoBillId))));
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
            const forEmployeeStored = clean(expense.partyType) === 'employee';
            rows.push({
                id: String(expense._id),
                partyType: expense.partyType,
                kind: 'balance',
                status: partyRowStatus({
                    paid: isPaid,
                    zohoBillId: expense.zohoBillId,
                    forEmployee: forEmployeeStored,
                }),
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
                canPay: forEmployeeStored && !isPaid,
                employeeId: clean(expense.employeeId),
                employeeName: clean(expense.employeeName),
                companyId: clean(expense.companyId),
                companyName: clean(expense.companyName),
            });
        }

        if (isCompanyList) {
            const companyOids = partyVariants
                .filter((id) => mongoose.Types.ObjectId.isValid(id) && String(id).length === 24)
                .map((id) => new mongoose.Types.ObjectId(id));
            if (companyOids.length) {
                const assets = await AssetItem.find({
                    assignedCompany: { $in: companyOids },
                })
                    .select('assetId name services assignedCompany')
                    .lean();
                const extraZohoIds = new Set();
                for (const asset of assets) {
                    for (const service of asset.services || []) {
                        const remark = parseJsonRemark(service.remark);
                        collectRemarkZohoBillIds(remark).forEach((id) => extraZohoIds.add(id));
                    }
                }
                const missingZoho = [...extraZohoIds].filter((id) => !paidZohoIds.has(id));
                if (missingZoho.length) {
                    const extraBills = await ZohoBill.find({ zohoBillId: { $in: missingZoho } })
                        .select('zohoBillId status balance total')
                        .lean();
                    for (const zb of extraBills) {
                        if (isZohoBillFullyPaid(zb)) paidZohoIds.add(clean(zb.zohoBillId));
                    }
                }
                const variantSet = new Set(partyVariants.map((v) => String(v)));
                for (const asset of assets) {
                    for (const service of asset.services || []) {
                        const remark = parseJsonRemark(service.remark);
                        const amountMode = clean(remark.amountMode).toLowerCase();
                        if (amountMode === 'warranty') continue;
                        const partyId = clean(remark.companyPayPartyId);
                        if (partyId && !variantSet.has(partyId) && !mongoose.Types.ObjectId.isValid(partyId)) {
                            continue;
                        }
                        if (partyId && mongoose.Types.ObjectId.isValid(partyId) && String(partyId).length === 24) {
                            if (!variantSet.has(partyId) && !companyOids.some((oid) => String(oid) === partyId)) {
                                continue;
                            }
                        }
                        const amount = money(
                            remark.hrReviewCompanyPay ?? remark.companyPayAmount ?? 0,
                        );
                        const employeeAmt = money(
                            remark.hrReviewEmployeePay ?? remark.employeePayAmount ?? 0,
                        );
                        const zohoIds = collectRemarkZohoBillIds(remark);
                        const hasBill = zohoIds.length > 0;
                        if (amount <= 0 && employeeAmt > 0) continue;
                        if (amount <= 0 && !hasBill) continue;
                        const paid = remarkServiceIsPaid(remark, paidZohoIds);
                        const serviceType = clean(service.serviceType, 'Service');
                        const assetRef = clean(asset.assetId || asset._id);
                        rows.push({
                            id: `service:${asset._id}:${service._id || zohoIds[0] || serviceType}`,
                            partyType: 'company',
                            kind: 'service',
                            status: paid ? 'Paid' : hasBill ? 'Not Paid' : 'Not Paid',
                            amount: amount > 0 ? amount : money(service.value),
                            description: `${serviceType} · ${clean(asset.name || asset.assetId)}`,
                            utilityBillId: '',
                            utilityBatchId: '',
                            accountNo: clean(asset.assetId),
                            utilityType: serviceType,
                            billMonth: service.date
                                ? String(service.date).slice(0, 7)
                                : '',
                            entryId: '',
                            zohoBillId: zohoIds[0] || '',
                            zohoPaymentId: clean(remark.zohoPaymentId),
                            zohoPaymentNumber: clean(remark.zohoPaymentNumber),
                            zohoOrganizationId: clean(remark.zohoOrganizationId),
                            zohoJournalId: '',
                            paidThroughAccountId: '',
                            paidThroughAccountName: '',
                            paymentMode: '',
                            paidAt: paid ? remark.zohoPaidAt || service.date || null : null,
                            ledger: [],
                            billLink: assetRef
                                ? `/HRM/Asset/Vehicle/details/${encodeURIComponent(assetRef)}`
                                : '',
                            paymentLink: '',
                            canPay: false,
                            employeeId: '',
                            employeeName: '',
                            companyId: clean(companyId),
                            companyName: clean(companyNames[0]),
                            serviceId: clean(service._id),
                        });
                    }
                }
            }
        }

        rows.sort((a, b) => {
            if (a.status !== b.status) return a.status === 'Not Paid' ? -1 : 1;
            return String(b.billMonth || '').localeCompare(String(a.billMonth || ''));
        });

        return res.status(200).json({
            success: true,
            rows: collapseSameBillPayableRows(rows),
        });
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
