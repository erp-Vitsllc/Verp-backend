import Loan from '../../models/Loan.js';
import Payment from '../../models/Payment.js';
import { getCompleteEmployee } from '../../services/employeeService.js';

/**
 * Retry Zoho Expense when sync failed, or live Paid loan has no Zoho expense yet.
 * On success: posts Zoho Expense and completes Paid to Employee when fully covered.
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
        const postManagement = ['Paid', 'Approved', 'Pending Payment to Employee'].includes(status);
        if (!postManagement) {
            return res.status(400).json({
                success: false,
                message:
                    'Retry Zoho Expense is only available after Management approval (Pay to Employee / Paid).',
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

        const findLatestPayment = async (statuses) =>
            (await Payment.findOne({
                relatedEntityId: String(loan._id),
                relatedEntityType: { $in: ['Loan', 'Advance'] },
                status: { $in: statuses },
            })
                .sort({ createdAt: -1 })
                .exec()) ||
            (await Payment.findOne({
                referenceId: String(loan.loanId || ''),
                paymentType: { $in: ['Loan', 'Advance'] },
                status: { $in: statuses },
            })
                .sort({ createdAt: -1 })
                .exec());

        // Prefer Completed (legacy live Paid), else Failed from Zoho-gated pay path.
        let payment =
            (await findLatestPayment(['Completed'])) || (await findLatestPayment(['Failed']));

        let createdPaymentForRetry = false;
        if (!payment) {
            const amount =
                Math.max(0, Number(loan.amount || 0) - Number(loan.paidAmount || 0)) ||
                Number(loan.amount || 0);
            if (!(amount > 0.01)) {
                return res.status(400).json({
                    success: false,
                    message:
                        'No ERP payment found and no remaining amount to pay. Cannot create Zoho Expense.',
                });
            }

            const employeeDoc = await getCompleteEmployee(loan.employeeId);
            if (!employeeDoc?._id) {
                return res.status(400).json({
                    success: false,
                    message: 'Employee not found for this loan/advance.',
                });
            }

            const paymentCount = await Payment.countDocuments();
            const paymentId = `PAY-${String(paymentCount + 1).padStart(6, '0')}`;
            payment = new Payment({
                paymentId,
                paymentType: loan.type === 'Advance' ? 'Advance' : 'Loan',
                paidBy: employeeDoc._id,
                paidByName: `${employeeDoc.firstName || ''} ${employeeDoc.lastName || ''}`.trim(),
                amount,
                status: 'Failed',
                description: `Retry Zoho payment for ${loan.loanId || id}`,
                referenceId: loan.loanId || null,
                relatedEntityType: loan.type === 'Advance' ? 'Advance' : 'Loan',
                relatedEntityId: loan._id,
                createdBy: req.user?._id || req.user?.id,
                paymentSource: 'Cash',
                zohoOrganizationId: String(loan.zohoOrganizationId || '').trim(),
                expenseAccountId: debitId,
                expenseAccountName: loan.expenseAccountName || '',
                paidThroughAccountId: creditId,
                paidThroughAccountName: loan.paidThroughAccountName || '',
                zohoSyncError: loan.zohoSyncError || 'Awaiting Zoho Expense retry',
            });
            await payment.save();
            createdPaymentForRetry = true;
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

        if (zohoResult.ok && String(zohoResult.expenseId || '').trim()) {
            const wasFailedPayment = String(payment.status || '') === 'Failed';

            payment.status = 'Completed';
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

            const allPayments = await Payment.find({
                $or: [{ relatedEntityId: loan._id }, { referenceId: loan.loanId }],
                relatedEntityType: { $in: ['Loan', 'Advance'] },
                status: 'Completed',
            });
            const totalPaid = allPayments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
            loan.paidAmount = totalPaid;

            if (parseFloat(loan.amount || 0) - totalPaid <= 0.01) {
                const { applyLoanFullyPaid } = await import('../../utils/loanPaymentStatus.js');
                await applyLoanFullyPaid(loan);
            } else {
                await loan.save();
            }

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
                message:
                    zohoResult.message ||
                    (wasFailedPayment || createdPaymentForRetry
                        ? 'Zoho Expense created. Paid to Employee completed.'
                        : 'Zoho Expense created.'),
                loan,
                expenseId: zohoResult.expenseId,
                expenseNumber: zohoResult.expenseNumber || '',
            });
        }

        loan.zohoSyncError = zohoResult.message || 'Zoho sync failed';
        await loan.save();
        payment.zohoSyncError = zohoResult.message || 'Zoho sync failed';
        if (createdPaymentForRetry || String(payment.status || '') === 'Failed') {
            payment.status = 'Failed';
        }
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
