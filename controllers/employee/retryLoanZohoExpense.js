import Loan from '../../models/Loan.js';
import Payment from '../../models/Payment.js';
import { getCompleteEmployee } from '../../services/employeeService.js';

/**
 * Retry Zoho Expense create for a Paid loan/advance when ERP payment succeeded
 * but Zoho sync failed (e.g. invalid Expense Account type).
 */
export const retryLoanZohoExpense = async (req, res) => {
    const { id } = req.params;
    const {
        expenseAccountId,
        expenseAccountName,
        paidThroughAccountId,
        paidThroughAccountName,
        zohoOrganizationId,
    } = req.body || {};

    try {
        const loan = await Loan.findById(id);
        if (!loan) {
            return res.status(404).json({ success: false, message: 'Loan request not found' });
        }

        const status = String(loan.approvalStatus || loan.status || '');
        if (status !== 'Paid') {
            return res.status(400).json({
                success: false,
                message: 'Retry Zoho Expense is only available after the loan/advance is Paid in ERP.',
            });
        }

        if (String(loan.zohoExpenseId || '').trim()) {
            return res.status(200).json({
                success: true,
                skipped: true,
                message: 'Zoho Expense already exists for this loan/advance.',
                loan,
                expenseId: loan.zohoExpenseId,
                expenseNumber: loan.zohoExpenseNumber || '',
            });
        }

        if (expenseAccountId !== undefined) {
            loan.expenseAccountId = String(expenseAccountId || '').trim();
        }
        if (expenseAccountName !== undefined) {
            loan.expenseAccountName = String(expenseAccountName || '').trim();
        }
        if (paidThroughAccountId !== undefined) {
            loan.paidThroughAccountId = String(paidThroughAccountId || '').trim();
        }
        if (paidThroughAccountName !== undefined) {
            loan.paidThroughAccountName = String(paidThroughAccountName || '').trim();
        }
        if (zohoOrganizationId !== undefined) {
            loan.zohoOrganizationId = String(zohoOrganizationId || '').trim();
        }

        const debitId = String(loan.expenseAccountId || '').trim();
        const creditId = String(loan.paidThroughAccountId || '').trim();
        if (!debitId || !creditId) {
            return res.status(400).json({
                success: false,
                message: 'Expense Account and Paid Through are required before retrying Zoho.',
            });
        }
        if (debitId === creditId) {
            return res.status(400).json({
                success: false,
                message: 'Expense Account and Paid Through must be different accounts.',
            });
        }

        await loan.save();

        const payment =
            (await Payment.findOne({
                relatedEntityId: String(loan._id),
                relatedEntityType: { $in: ['Loan', 'Advance'] },
                status: 'Completed',
            })
                .sort({ createdAt: -1 })
                .exec()) ||
            (await Payment.findOne({
                referenceId: String(loan.loanId || ''),
                paymentType: { $in: ['Loan', 'Advance'] },
                status: 'Completed',
            })
                .sort({ createdAt: -1 })
                .exec());

        if (!payment) {
            return res.status(400).json({
                success: false,
                message: 'No completed ERP payment found for this loan/advance. Cannot create Zoho Expense.',
            });
        }

        const employee = await getCompleteEmployee(loan.employeeId);
        const { syncLoanPaymentToZoho } = await import('../../utils/syncRewardPaymentToZoho.js');
        const zohoResult = await syncLoanPaymentToZoho({
            payment,
            loan,
            employee,
            organizationId: loan.zohoOrganizationId || payment.zohoOrganizationId,
            expenseAccountId: debitId,
            expenseAccountName: loan.expenseAccountName,
            paidThroughAccountId: creditId,
            paidThroughAccountName: loan.paidThroughAccountName,
        });

        if (zohoResult.ok) {
            payment.zohoExpenseId = zohoResult.expenseId || payment.zohoExpenseId || '';
            payment.zohoOrganizationId =
                zohoResult.organizationId || payment.zohoOrganizationId || '';
            payment.expenseAccountId = debitId;
            payment.expenseAccountName = loan.expenseAccountName || '';
            payment.paidThroughAccountId = creditId;
            payment.paidThroughAccountName = loan.paidThroughAccountName || '';
            payment.zohoSyncError =
                zohoResult.attachment?.ok === false
                    ? zohoResult.message ||
                      `Zoho Expense created; attachment failed: ${zohoResult.attachment.message}`
                    : '';
            await payment.save();

            loan.zohoExpenseId = zohoResult.expenseId || loan.zohoExpenseId;
            loan.zohoExpenseNumber = zohoResult.expenseNumber || loan.zohoExpenseNumber || '';
            loan.zohoOrganizationId = zohoResult.organizationId || loan.zohoOrganizationId;
            loan.zohoSyncedAt = new Date();
            loan.zohoSyncError =
                zohoResult.attachment?.ok === false ? zohoResult.message || '' : '';
            await loan.save();

            try {
                const { upsertLoanPartyExpenseFromPayment } = await import(
                    '../../utils/upsertLoanPartyExpenseFromPayment.js'
                );
                await upsertLoanPartyExpenseFromPayment({
                    loan,
                    payment,
                    employee,
                    zohoResult,
                    userId: req.user?._id || null,
                });
            } catch (expenseErr) {
                console.warn(
                    '[retryLoanZohoExpense] Party expense upsert failed:',
                    expenseErr?.message || expenseErr,
                );
            }

            return res.status(200).json({
                success: true,
                message: zohoResult.message || 'Zoho Expense created.',
                loan,
                expenseId: zohoResult.expenseId,
                expenseNumber: zohoResult.expenseNumber || '',
            });
        }

        loan.zohoSyncError = zohoResult.message || 'Zoho sync failed';
        await loan.save();
        payment.zohoSyncError = zohoResult.message || 'Zoho sync failed';
        await payment.save();

        return res.status(422).json({
            success: false,
            message: zohoResult.message || 'Zoho Expense sync failed',
            loan,
        });
    } catch (error) {
        console.error('[retryLoanZohoExpense]', error);
        return res.status(500).json({
            success: false,
            message: error?.message || 'Failed to retry Zoho Expense',
        });
    }
};
