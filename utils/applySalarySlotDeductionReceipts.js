import mongoose from 'mongoose';
import EmployeeBasic from '../models/EmployeeBasic.js';
import Fine from '../models/Fine.js';
import Loan from '../models/Loan.js';
import PartyExpense from '../models/PartyExpense.js';
import Payment from '../models/Payment.js';
import UtilityBillPayment from '../models/UtilityBillPayment.js';
import { buildSalarySlipPayload } from './buildSalarySlipPayload.js';
import { resolveEmployeeFinePayableAmount } from './finePayableAmount.js';
import { sendPaymentNotificationEmail } from './sendCombinedPaymentEmail.js';
import {
    countsTowardUtilityEmployeePortion,
    employeePortionAmount,
} from './utilityEmployeePortionStatus.js';

function money(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 100) / 100;
}

function monthKeyOf(value) {
    const match = String(value || '').trim().match(/^(\d{4}-\d{2})/);
    return match ? match[1] : '';
}

/** Slip rows whose this-month amount should be marked paid when the slot payment is posted. */
export function salarySlipDeductionReceiptLines(slip) {
    const lines = [];
    const push = (kind, row) => {
        const sourceId = String(row?.sourceId || '').trim();
        const amount = money(row?.thisMonthAmount ?? row?.thisMonth);
        if (!sourceId || !mongoose.Types.ObjectId.isValid(sourceId) || amount <= 0.009) return;
        lines.push({ kind, sourceId, amount });
    };
    for (const row of slip?.loanSchedule || []) {
        const type = String(row?.type || '');
        if (/advance/i.test(type)) push('advance', row);
        else if (/loan/i.test(type)) push('loan', row);
    }
    for (const row of slip?.fines || []) push('fine', row);
    for (const row of slip?.utilities || []) push('utility', row);
    return lines;
}

function receiptRemark(slotId, employeeId, kind, sourceId) {
    return `payroll-slot:${String(slotId)}:${String(employeeId)}:${kind}:${String(sourceId)}`;
}

async function completedSum(query) {
    const rows = await Payment.find(query).select('amount description status').lean();
    return money(
        rows.reduce((sum, row) => {
            if (String(row?.status || 'Completed') !== 'Completed') return sum;
            return sum + (Number(row.amount) || 0);
        }, 0),
    );
}

async function syncInstallments(doc, recovered, total) {
    if (!doc) return;
    const parts = Array.isArray(doc.installments) ? doc.installments : [];
    if (parts.length) {
        let left = money(recovered);
        doc.installments = parts.map((row) => {
            const plain = typeof row?.toObject === 'function' ? row.toObject() : { ...row };
            const part = money(plain.amount);
            const paidHere = Math.min(left, part);
            left = money(left - paidHere);
            return {
                ...plain,
                status: part > 0.009 && paidHere + 0.009 >= part ? 'Paid' : 'Not Paid',
            };
        });
    }
    if (total > 0.009 && recovered + 0.01 >= total) {
        doc.status = 'Paid';
        doc.paymentMode = doc.paymentMode || 'Payroll';
        doc.paidAt = doc.paidAt || new Date();
    }
    await doc.save();
}

async function applyFine(line, employee, monthKey, remark, userId) {
    const fine = await Fine.findById(line.sourceId);
    if (!fine) return null;
    const payable = money(resolveEmployeeFinePayableAmount(fine, employee.employeeId));
    const paidSoFar = money(
        await completedSum({
            relatedEntityType: 'Fine',
            status: 'Completed',
            $or: [
                { relatedEntityId: fine._id },
                ...(fine.fineId ? [{ referenceId: fine.fineId }] : []),
            ],
        }),
    );
    const outstanding = money(Math.max(0, payable - paidSoFar));
    const amount = money(Math.min(line.amount, outstanding));
    if (amount <= 0.009) return null;
    const payment = await Payment.create({
        paymentType: 'Fine',
        relatedEntityType: 'Fine',
        relatedEntityId: fine._id,
        referenceId: String(fine.fineId || ''),
        amount,
        status: 'Completed',
        paymentDate: new Date(),
        paymentSource: 'Salary',
        paymentMode: 'Payroll',
        paidBy: employee._id,
        paidByName: `${employee.firstName || ''} ${employee.lastName || ''}`.trim(),
        settleEmployeeId: String(employee.employeeId || ''),
        createdBy: userId,
        description: `Payroll deduction ${monthKey}. Fine AED ${amount.toFixed(2)} paid from salary.`,
        remarks: remark,
    });
    const paidNow = money(paidSoFar + amount);
    fine.paidAmount = paidNow;
    if (payable - paidNow <= 0.01) fine.fineStatus = 'Paid';
    await fine.save();
    const party = await PartyExpense.findOne({
        kind: 'fine',
        fineMongoId: String(fine._id),
        partyType: 'employee',
        employeeId: String(employee.employeeId || ''),
    });
    await syncInstallments(party, paidNow, payable);
    return payment;
}

async function applyLoan(line, employee, monthKey, remark, userId) {
    const loan = await Loan.findById(line.sourceId);
    if (!loan) return null;
    const isAdvance = line.kind === 'advance' || /advance/i.test(String(loan.type || ''));
    const relatedEntityType = isAdvance ? 'AdvanceRepayment' : 'LoanRepayment';
    const paymentType = isAdvance ? 'Advance' : 'Loan';
    const total = money(loan.amount);
    const paidSoFar = money(
        await completedSum({
            relatedEntityType: { $in: ['LoanRepayment', 'AdvanceRepayment'] },
            status: 'Completed',
            $or: [{ relatedEntityId: loan._id }, ...(loan.loanId ? [{ referenceId: loan.loanId }] : [])],
        }),
    );
    const outstanding = money(Math.max(0, total - paidSoFar));
    const amount = money(Math.min(line.amount, outstanding));
    if (amount <= 0.009) return null;
    const label = isAdvance ? 'Advance' : 'Loan';
    const payment = await Payment.create({
        paymentType,
        relatedEntityType,
        relatedEntityId: loan._id,
        referenceId: String(loan.loanId || ''),
        amount,
        status: 'Completed',
        paymentDate: new Date(),
        paymentSource: 'Salary',
        paymentMode: 'Payroll',
        paidBy: employee._id,
        paidByName: `${employee.firstName || ''} ${employee.lastName || ''}`.trim(),
        settleEmployeeId: String(employee.employeeId || ''),
        createdBy: userId,
        description: `Payroll deduction ${monthKey}. ${label} AED ${amount.toFixed(2)} paid from salary.`,
        remarks: remark,
    });
    const paidNow = money(paidSoFar + amount);
    loan.repaidAmount = paidNow;
    if (total - paidNow <= 0.01 && !String(loan.accountsRepaymentPath || '').trim()) {
        loan.accountsRepaymentPath = 'employee';
        loan.accountsRepaymentAt = new Date();
        if (userId) loan.accountsRepaymentBy = userId;
    }
    await loan.save();
    const party = await PartyExpense.findOne({
        kind: isAdvance ? 'advance' : 'loan',
        loanMongoId: String(loan._id),
        partyType: 'employee',
        employeeId: String(employee.employeeId || loan.employeeId || ''),
    });
    await syncInstallments(party, paidNow, total);
    return payment;
}

async function applyUtility(line, employee, monthKey, remark, userId) {
    const bill = await UtilityBillPayment.findById(line.sourceId);
    if (!bill) return null;
    const ids = [employee.employeeId, employee._id].filter(Boolean).map((id) => String(id));
    const portion = money(employeePortionAmount(bill, ids));
    const payments = await Payment.find({
        relatedEntityType: 'UtilityBill',
        relatedEntityId: bill._id,
        status: 'Completed',
    })
        .select('amount description status')
        .lean();
    const paidSoFar = money(
        payments.reduce((sum, row) => {
            if (!countsTowardUtilityEmployeePortion(row)) return sum;
            return sum + (Number(row.amount) || 0);
        }, 0),
    );
    const outstanding = money(Math.max(0, portion - paidSoFar));
    const amount = money(Math.min(line.amount, outstanding));
    if (amount <= 0.009) return null;
    const payment = await Payment.create({
        paymentType: 'UtilityBill',
        relatedEntityType: 'UtilityBill',
        relatedEntityId: bill._id,
        referenceId: String(bill.billNumber || bill.accountNo || ''),
        amount,
        status: 'Completed',
        paymentDate: new Date(),
        paymentSource: 'Salary',
        paymentMode: 'Payroll',
        paidBy: employee._id,
        paidByName: `${employee.firstName || ''} ${employee.lastName || ''}`.trim(),
        settleEmployeeId: String(employee.employeeId || ''),
        createdBy: userId,
        description: `Payroll deduction ${monthKey}. Utility AED ${amount.toFixed(2)} paid from salary.`,
        remarks: remark,
    });
    const paidNow = money(paidSoFar + amount);
    if (portion > 0.009 && paidNow + 0.009 >= portion) {
        const party = await PartyExpense.findOne({
            utilityBillId: String(bill._id),
            kind: 'balance',
            partyType: 'employee',
            employeeId: String(employee.employeeId || ''),
        });
        if (party) {
            party.status = 'Paid';
            party.paymentMode = 'Payroll';
            party.paidAt = party.paidAt || new Date();
            await party.save();
        }
    }
    return payment;
}

/**
 * After the salary slot Zoho expense is saved, mark this month's slip deductions paid
 * and email each employee the receipt.
 */
export async function applySalarySlotDeductionReceipts({
    employeeIds = [],
    monthKey = '',
    slotId = '',
    userId = null,
} = {}) {
    const month = monthKeyOf(monthKey);
    const actorId = String(userId || '').trim();
    if (!month || !slotId || !mongoose.Types.ObjectId.isValid(actorId)) return { sent: 0 };
    const codes = [...new Set((employeeIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    let sent = 0;
    for (const employeeId of codes) {
        try {
            const employee = await EmployeeBasic.findOne({ employeeId })
                .select('employeeId firstName lastName')
                .lean();
            if (!employee?._id) continue;
            const slip = await buildSalarySlipPayload({ employeeId, monthKey: month });
            const lines = salarySlipDeductionReceiptLines(slip);
            for (const line of lines) {
                const remark = receiptRemark(slotId, employeeId, line.kind, line.sourceId);
                const existing = await Payment.findOne({ remarks: remark, status: 'Completed' })
                    .select('_id')
                    .lean();
                if (existing) continue;
                let payment = null;
                if (line.kind === 'fine') {
                    payment = await applyFine(line, employee, month, remark, actorId);
                } else if (line.kind === 'loan' || line.kind === 'advance') {
                    payment = await applyLoan(line, employee, month, remark, actorId);
                } else if (line.kind === 'utility') {
                    payment = await applyUtility(line, employee, month, remark, actorId);
                }
                if (!payment) continue;
                sent += 1;
                sendPaymentNotificationEmail(payment, 'Completed').catch((error) => {
                    console.error(
                        '[salary slot deduction receipt]',
                        employeeId,
                        line.kind,
                        error?.message || error,
                    );
                });
            }
        } catch (error) {
            console.error('[salary slot deduction receipt]', employeeId, error?.message || error);
        }
    }
    return { sent };
}
