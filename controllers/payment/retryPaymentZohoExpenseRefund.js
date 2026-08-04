import Payment from '../../models/Payment.js';
import Fine from '../../models/Fine.js';
import Loan from '../../models/Loan.js';
import UtilityBillPayment from '../../models/UtilityBillPayment.js';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import {
    resolveEmployeeFinePayableAmount,
    resolvePrimaryEmployeeId,
} from '../../utils/finePayableAmount.js';

const EXPENSE_REFUND_TYPES = new Set([
    'Fine',
    'LoanRepayment',
    'AdvanceRepayment',
    'UtilityBill',
]);

/**
 * Retry Zoho Banking Expense Refund for a payment that failed sync
 * (status Failed, or Completed with zohoSyncError and no zohoExpenseId).
 * On success: marks Completed and recalculates Fine paidAmount / Loan repaidAmount.
 */
export const retryPaymentZohoExpenseRefund = async (req, res) => {
    try {
        const { id } = req.params;
        const body = req.body || {};

        const payment = await Payment.findById(id);
        if (!payment) {
            return res.status(404).json({ success: false, message: 'Payment not found' });
        }

        const entityType = String(payment.relatedEntityType || '').trim();
        if (!EXPENSE_REFUND_TYPES.has(entityType)) {
            return res.status(400).json({
                success: false,
                message:
                    'Retry Zoho Expense Refund is only for Fine / Loan / Advance / Utility refund payments.',
            });
        }

        if (String(payment.zohoExpenseId || '').trim()) {
            return res.status(200).json({
                success: true,
                skipped: true,
                message: 'Zoho Expense Refund already exists for this payment.',
                payment,
                expenseId: payment.zohoExpenseId,
            });
        }

        // Allow body overrides for COA / tax on retry
        const assignIfProvided = (field, value) => {
            if (value !== undefined && value !== null && String(value).trim() !== '') {
                payment[field] = String(value).trim();
            }
        };
        assignIfProvided('expenseAccountId', body.expenseAccountId);
        assignIfProvided('expenseAccountName', body.expenseAccountName);
        assignIfProvided('paidThroughAccountId', body.paidThroughAccountId);
        assignIfProvided('paidThroughAccountName', body.paidThroughAccountName);
        assignIfProvided('zohoOrganizationId', body.zohoOrganizationId);
        assignIfProvided('locationId', body.locationId);
        assignIfProvided('taxTreatment', body.taxTreatment);
        assignIfProvided('placeOfSupply', body.placeOfSupply);
        assignIfProvided('taxId', body.taxId);
        assignIfProvided('vendorId', body.vendorId);
        assignIfProvided('vendorName', body.vendorName);
        assignIfProvided('paymentMode', body.paymentMode);
        if (typeof body.isInclusiveTax === 'boolean') {
            payment.isInclusiveTax = body.isInclusiveTax;
        }

        const paidThroughId = String(payment.paidThroughAccountId || '').trim();
        const expenseId = String(payment.expenseAccountId || '').trim();
        if (!paidThroughId || !expenseId) {
            return res.status(400).json({
                success: false,
                message: 'Expense Account and Paid Through are required before Retry Zoho.',
            });
        }
        if (paidThroughId === expenseId) {
            return res.status(400).json({
                success: false,
                message: 'Expense Account and Paid Through must be different.',
            });
        }

        await payment.save();

        const employee = await EmployeeBasic.findById(payment.paidBy);
        if (!employee) {
            return res.status(400).json({
                success: false,
                message: 'Employee not found for this payment.',
            });
        }

        const syncArgs = {
            payment,
            employee,
            organizationId: payment.zohoOrganizationId,
            expenseAccountId: expenseId,
            expenseAccountName: payment.expenseAccountName,
            paidThroughAccountId: paidThroughId,
            paidThroughAccountName: payment.paidThroughAccountName,
            locationId: payment.locationId,
            taxTreatment: payment.taxTreatment,
            placeOfSupply: payment.placeOfSupply,
            taxId: payment.taxId,
            isInclusiveTax:
                typeof payment.isInclusiveTax === 'boolean' ? payment.isInclusiveTax : true,
            paymentMode: payment.paymentMode || 'Cash',
            vendorId: payment.vendorId,
            vendorName: payment.vendorName,
            attachments: payment.attachment ? [payment.attachment] : [],
        };

        let zohoResult = { ok: false, message: 'Zoho sync failed' };

        if (entityType === 'Fine') {
            let fine =
                (payment.relatedEntityId && (await Fine.findById(payment.relatedEntityId))) ||
                (payment.referenceId
                    ? await Fine.findOne({ fineId: payment.referenceId })
                    : null);
            if (!fine) {
                return res.status(404).json({ success: false, message: 'Fine not found' });
            }
            const { syncFineCompanyPaymentToZoho } = await import(
                '../../utils/syncFineCompanyPaymentToZoho.js'
            );
            zohoResult = await syncFineCompanyPaymentToZoho({ ...syncArgs, fine });
            if (!zohoResult.ok || !String(zohoResult.expenseId || '').trim()) {
                payment.status = 'Failed';
                payment.zohoSyncError = zohoResult.message || 'Zoho Expense Refund failed';
                await payment.save();
                return res.status(422).json({
                    success: false,
                    message: payment.zohoSyncError,
                    payment,
                    zohoSync: { ok: false, message: payment.zohoSyncError },
                });
            }
            payment.status = 'Completed';
            payment.zohoExpenseId = zohoResult.expenseId;
            payment.zohoSyncError = '';
            payment.zohoOrganizationId =
                zohoResult.organizationId || payment.zohoOrganizationId;
            await payment.save();

            const paymentQuery = {
                relatedEntityType: 'Fine',
                status: 'Completed',
                $or: [],
            };
            if (fine._id) paymentQuery.$or.push({ relatedEntityId: fine._id });
            if (fine.fineId) paymentQuery.$or.push({ referenceId: fine.fineId });
            const completed = paymentQuery.$or.length
                ? await Payment.find(paymentQuery)
                : [];
            const totalPaid = completed.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
            fine.paidAmount = totalPaid;
            const share = resolveEmployeeFinePayableAmount(
                fine,
                employee.employeeId || resolvePrimaryEmployeeId(fine),
            );
            if (share - totalPaid <= 0.01) fine.fineStatus = 'Paid';
            await fine.save();
        } else if (entityType === 'LoanRepayment' || entityType === 'AdvanceRepayment') {
            let loan =
                (payment.relatedEntityId && (await Loan.findById(payment.relatedEntityId))) ||
                (payment.referenceId
                    ? await Loan.findOne({ loanId: payment.referenceId })
                    : null);
            if (!loan) {
                return res.status(404).json({ success: false, message: 'Loan/Advance not found' });
            }
            const { syncLoanRepaymentPaymentToZoho } = await import(
                '../../utils/syncFineCompanyPaymentToZoho.js'
            );
            zohoResult = await syncLoanRepaymentPaymentToZoho({ ...syncArgs, loan });
            if (!zohoResult.ok || !String(zohoResult.expenseId || '').trim()) {
                payment.status = 'Failed';
                payment.zohoSyncError = zohoResult.message || 'Zoho Expense Refund failed';
                await payment.save();
                return res.status(422).json({
                    success: false,
                    message: payment.zohoSyncError,
                    payment,
                    zohoSync: { ok: false, message: payment.zohoSyncError },
                });
            }
            payment.status = 'Completed';
            payment.zohoExpenseId = zohoResult.expenseId;
            payment.zohoSyncError = '';
            payment.zohoOrganizationId =
                zohoResult.organizationId || payment.zohoOrganizationId;
            await payment.save();

            const repaymentQuery = {
                relatedEntityType: { $in: ['LoanRepayment', 'AdvanceRepayment'] },
                status: 'Completed',
            };
            const byId = await Payment.find({ ...repaymentQuery, relatedEntityId: loan._id });
            const byRef = loan.loanId
                ? await Payment.find({ ...repaymentQuery, referenceId: loan.loanId })
                : [];
            const ids = new Set();
            const merged = [];
            [...byId, ...byRef].forEach((p) => {
                if (!ids.has(p._id.toString())) {
                    ids.add(p._id.toString());
                    merged.push(p);
                }
            });
            loan.repaidAmount = merged.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
            await loan.save();
        } else if (entityType === 'UtilityBill') {
            let utilityBill =
                (payment.relatedEntityId &&
                    (await UtilityBillPayment.findById(payment.relatedEntityId))) ||
                null;
            if (!utilityBill) {
                return res.status(404).json({ success: false, message: 'Utility bill not found' });
            }
            const { syncUtilityDifferencePaymentToZoho } = await import(
                '../../utils/syncFineCompanyPaymentToZoho.js'
            );
            zohoResult = await syncUtilityDifferencePaymentToZoho({
                ...syncArgs,
                utilityBill,
            });
            if (!zohoResult.ok || !String(zohoResult.expenseId || '').trim()) {
                payment.status = 'Failed';
                payment.zohoSyncError = zohoResult.message || 'Zoho Expense Refund failed';
                await payment.save();
                return res.status(422).json({
                    success: false,
                    message: payment.zohoSyncError,
                    payment,
                    zohoSync: { ok: false, message: payment.zohoSyncError },
                });
            }
            payment.status = 'Completed';
            payment.zohoExpenseId = zohoResult.expenseId;
            payment.zohoSyncError = '';
            payment.zohoOrganizationId =
                zohoResult.organizationId || payment.zohoOrganizationId;
            await payment.save();
        }

        await payment.populate('paidBy', 'employeeId firstName lastName');

        return res.status(200).json({
            success: true,
            message: 'Zoho Expense Refund posted. Payment approved.',
            payment,
            zohoSync: {
                ok: true,
                expenseId: zohoResult.expenseId || '',
                expenseNumber: zohoResult.expenseNumber || '',
                message: zohoResult.message || '',
            },
        });
    } catch (error) {
        console.error('[retryPaymentZohoExpenseRefund]', error);
        return res.status(500).json({
            success: false,
            message: error?.message || 'Failed to retry Zoho Expense Refund',
        });
    }
};
