import mongoose from 'mongoose';
import UtilityBillPayment from '../models/UtilityBillPayment.js';
import PartyExpense from '../models/PartyExpense.js';
import Payment from '../models/Payment.js';
import SalaryMonthPayment from '../models/SalaryMonthPayment.js';
import ZohoExpense from '../models/ZohoExpense.js';
import { employeeIdQueryVariants } from './upsertUtilityBalancePartyExpense.js';

function money(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 100) / 100;
}

export function utilityMonthKey(value) {
    const match = String(value || '').trim().match(/^(\d{4}-\d{2})/);
    return match ? match[1] : '';
}

/** This employee's payable share: line amounts, else the bill employee total. */
export function employeePortionAmount(bill, employeeIds = []) {
    const ids = new Set(
        (Array.isArray(employeeIds) ? employeeIds : [employeeIds])
            .map((id) => String(id || '').trim())
            .filter(Boolean),
    );
    if (!ids.size || !bill) return 0;
    const lines = Array.isArray(bill.zohoLineItems) ? bill.zohoLineItems : [];
    let sum = 0;
    let matched = false;
    for (const line of lines) {
        const empId = String(line?.payByEmployeeId || '').trim();
        if (!empId || !ids.has(empId)) continue;
        matched = true;
        sum += Number(line?.amount) || 0;
    }
    if (matched) return money(sum);
    if (ids.has(String(bill.payByEmployeeId || '').trim())) {
        return money(Number(bill.employeePayAmount) || 0);
    }
    return 0;
}

function payrollCoversBill(billMonth, payrollMonths) {
    const bill = utilityMonthKey(billMonth);
    if (!bill) return false;
    return (Array.isArray(payrollMonths) ? payrollMonths : []).some((month) => {
        const key = utilityMonthKey(month);
        return Boolean(key && key >= bill);
    });
}

/** Vendor Payments Made and the company share are not collection of the employee portion. */
export function countsTowardUtilityEmployeePortion(payment) {
    const text = String(payment?.description || '');
    if (/company share/i.test(text)) return false;
    if (/zoho payments made/i.test(text)) return false;
    return true;
}

function completedPaymentsForBill(payments, billId) {
    const id = String(billId || '');
    return (Array.isArray(payments) ? payments : []).filter((row) => {
        if (String(row?.relatedEntityId || '') !== id) return false;
        const status = String(row?.status || 'Completed');
        if (status !== 'Completed') return false;
        return countsTowardUtilityEmployeePortion(row);
    });
}

function portionCanBeCollected(billStatus) {
    return billStatus === 'Approved' || billStatus === 'Paid';
}

/**
 * Employee-profile status for one utility bill.
 * Only the unpaid employee portion is collected. A paid vendor bill does not clear it.
 * The portion is paid when its expense is in Zoho, payroll Zoho covered the month,
 * or Accounts recorded the portion.
 */
export function summarizeUtilityPortionSettlement({
    bill,
    employeeIds = [],
    payments = [],
    partyExpense = null,
    payrollZohoMonths = [],
    zohoExpenseMatched = false,
} = {}) {
    const portion = employeePortionAmount(bill, employeeIds);
    const billId = String(bill?._id || bill?.id || '');
    const billStatus = String(bill?.status || '');
    const rows = completedPaymentsForBill(payments, billId);
    const paidAmount = money(rows.reduce((sum, row) => sum + (Number(row?.amount) || 0), 0));
    const hasZohoExpense =
        Boolean(zohoExpenseMatched) ||
        rows.some((row) => String(row?.zohoExpenseId || '').trim());
    const payrollPaid = payrollCoversBill(bill?.billMonth, payrollZohoMonths);
    const partyPaid = String(partyExpense?.status || '') === 'Paid';
    const partyMode = String(partyExpense?.paymentMode || '').trim();
    const covered = portion > 0.009 && paidAmount + 0.009 >= portion;
    const employeeCovered =
        covered &&
        rows.some(
            (row) =>
                String(row?.settleEmployeeId || '').trim() &&
                !String(row?.zohoExpenseId || '').trim(),
        );

    let via = '';
    if (billStatus === 'Rejected') via = 'rejected';
    else if (hasZohoExpense) via = 'zoho_expense';
    else if (payrollPaid && portion > 0.009) via = 'payroll';
    else if (partyPaid && partyMode === 'Payroll') via = 'payroll';
    else if ((partyPaid && partyMode === 'Employee') || employeeCovered) via = 'employee';
    else if (partyPaid && covered) via = 'expense_refund';

    let status = 'Not Paid';
    if (via === 'rejected') status = 'Rejected';
    else if (via === 'employee') status = 'Paid Employee';
    else if (via) status = 'Paid';

    const settled = status === 'Paid' || status === 'Paid Employee';
    const outstanding = settled ? 0 : money(Math.max(0, portion - paidAmount));
    const canPay =
        portionCanBeCollected(billStatus) && outstanding > 0.009 && portion > 0.009;

    return {
        billId,
        portion,
        paidAmount,
        outstanding,
        status,
        via,
        canPay,
    };
}

/**
 * Unpaid employee portion due on a salary slip.
 * A future bill month stays off this slip. Company share and a paid vendor bill do not clear it.
 */
export function unpaidEmployeePortionOnSalaryMonth({ salaryMonth, ...settlement } = {}) {
    const target = utilityMonthKey(salaryMonth);
    if (target) {
        const billMonth = utilityMonthKey(settlement.bill?.billMonth);
        if (!billMonth || billMonth > target) return 0;
    }
    return summarizeUtilityPortionSettlement(settlement).outstanding;
}

/** Payments, payroll Zoho months, and balance rows used to price one employee's utility portion. */
export async function loadUtilityPortionContext(employeeIds, bills = []) {
    const variants = [...new Set((employeeIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    const list = Array.isArray(bills) ? bills : [];
    const ids = list.map((bill) => String(bill?._id || '')).filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (!list.length || !ids.length) {
        return {
            employeeIds: variants,
            payments: [],
            expenseByBill: new Map(),
            payrollZohoMonths: [],
            zohoMatched: new Set(),
        };
    }

    const objectIds = ids.map((id) => new mongoose.Types.ObjectId(id));
    const [payments, expenses, payrollZohoMonths, zohoMatched] = await Promise.all([
        Payment.find({
            relatedEntityType: 'UtilityBill',
            relatedEntityId: { $in: objectIds },
            status: 'Completed',
        })
            .select('relatedEntityId amount zohoExpenseId settleEmployeeId status description')
            .lean(),
        PartyExpense.find({
            utilityBillId: { $in: ids },
            kind: 'balance',
            partyType: 'employee',
            employeeId: { $in: variants.length ? variants : ['__none__'] },
        })
            .select('utilityBillId status paymentMode amount')
            .lean(),
        payrollZohoMonthsFor(variants),
        zohoExpenseMatchedBillIds(list),
    ]);

    return {
        employeeIds: variants,
        payments: payments || [],
        expenseByBill: new Map((expenses || []).map((row) => [String(row.utilityBillId || ''), row])),
        payrollZohoMonths,
        zohoMatched,
    };
}

function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function payrollZohoMonthsFor(variants) {
    const ids = (Array.isArray(variants) ? variants : []).map((id) => String(id || '').trim()).filter(Boolean);
    if (!ids.length) return [];
    const slots = await SalaryMonthPayment.find({
        employeeIds: { $in: ids },
        zohoExpenseId: { $nin: ['', null] },
        status: { $nin: ['cancelled', 'rejected'] },
    })
        .select('monthKey zohoExpenseId')
        .lean();
    return [...new Set(slots.map((row) => utilityMonthKey(row?.monthKey)).filter(Boolean))].sort();
}

/** Payroll Zoho expense means this month's utility portion was deducted. Mark those balances paid. */
export async function markUtilityPortionsPaidFromPayrollZoho(employeeIds, payrollMonths) {
    const variants = [...new Set((employeeIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    const months = (payrollMonths || []).map((month) => utilityMonthKey(month)).filter(Boolean).sort();
    if (!variants.length || !months.length) return 0;
    const latest = months[months.length - 1];
    const expenses = await PartyExpense.find({
        kind: 'balance',
        partyType: 'employee',
        employeeId: { $in: variants },
        status: 'Not Paid',
    });
    let marked = 0;
    for (const doc of expenses) {
        const billMonth = utilityMonthKey(doc.billMonth);
        if (!billMonth || billMonth > latest) continue;
        doc.status = 'Paid';
        doc.paymentMode = 'Payroll';
        doc.paidAt = doc.paidAt || new Date();
        await doc.save();
        marked += 1;
    }
    return marked;
}

async function zohoExpenseMatchedBillIds(bills) {
    const hints = (bills || [])
        .map((bill) => ({
            id: String(bill?._id || ''),
            account: String(bill?.accountNo || '').trim(),
            number: String(bill?.billNumber || '').trim(),
            month: utilityMonthKey(bill?.billMonth),
        }))
        .filter((hint) => hint.id);
    if (!hints.length) return new Set();

    const exactRefs = [
        ...new Set(
            hints
                .flatMap((hint) => [hint.number, hint.id])
                .filter((value) => value && value.length >= 3),
        ),
    ];
    const accounts = [...new Set(hints.map((hint) => hint.account).filter((value) => value.length >= 6))];
    const or = [];
    if (exactRefs.length) or.push({ referenceNumber: { $in: exactRefs } });
    if (exactRefs.length) or.push({ description: { $in: exactRefs } });
    if (accounts.length) {
        or.push({
            description: { $regex: accounts.map((account) => escapeRegex(account)).join('|'), $options: 'i' },
        });
    }
    if (!or.length) return new Set();

    const rows = await ZohoExpense.find({ isActive: { $ne: false }, $or: or })
        .select('referenceNumber description')
        .limit(500)
        .lean();

    const matched = new Set();
    for (const hint of hints) {
        const hit = rows.some((row) => {
            const ref = String(row?.referenceNumber || '').trim();
            const desc = String(row?.description || '');
            if (hint.number && ref === hint.number) return true;
            if (ref === hint.id || desc.includes(hint.id)) return true;
            if (
                hint.account.length >= 6 &&
                desc.includes(hint.account) &&
                (!hint.month || desc.includes(hint.month))
            ) {
                return true;
            }
            return false;
        });
        if (hit) matched.add(hint.id);
    }
    return matched;
}

export async function buildUtilityEmployeePortionStatus({ employeeId = '', billIds = [] } = {}) {
    const variants = await employeeIdQueryVariants(employeeId);
    const ids = [...new Set((Array.isArray(billIds) ? billIds : []).map((id) => String(id || '').trim()))]
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .slice(0, 400);
    const payrollZohoMonths = await payrollZohoMonthsFor(variants);
    if (variants.length && payrollZohoMonths.length) {
        await markUtilityPortionsPaidFromPayrollZoho(variants, payrollZohoMonths);
    }

    if (!ids.length) {
        return { employeeId: String(employeeId || ''), payrollZohoMonths, rows: [] };
    }

    const objectIds = ids.map((id) => new mongoose.Types.ObjectId(id));
    const [bills, payments, expenses] = await Promise.all([
        UtilityBillPayment.find({ _id: { $in: objectIds } }).lean(),
        Payment.find({
            relatedEntityType: 'UtilityBill',
            relatedEntityId: { $in: objectIds },
            status: 'Completed',
        })
            .select('relatedEntityId amount zohoExpenseId settleEmployeeId status description')
            .lean(),
        PartyExpense.find({
            utilityBillId: { $in: ids },
            kind: 'balance',
            partyType: 'employee',
            employeeId: { $in: variants.length ? variants : [String(employeeId || '')] },
        })
            .select('utilityBillId status paymentMode amount')
            .lean(),
    ]);

    const zohoMatched = await zohoExpenseMatchedBillIds(bills);
    const expenseByBill = new Map(
        (expenses || []).map((row) => [String(row.utilityBillId || ''), row]),
    );
    const rows = (bills || []).map((bill) =>
        summarizeUtilityPortionSettlement({
            bill,
            employeeIds: variants,
            payments,
            partyExpense: expenseByBill.get(String(bill._id)) || null,
            payrollZohoMonths,
            zohoExpenseMatched: zohoMatched.has(String(bill._id)),
        }),
    );

    return {
        employeeId: String(employeeId || ''),
        payrollZohoMonths,
        rows,
    };
}
