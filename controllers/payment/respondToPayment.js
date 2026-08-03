import Payment from "../../models/Payment.js";
import DashboardAction from "../../models/DashboardAction.js";
import Fine from "../../models/Fine.js";
import Loan from "../../models/Loan.js";
import Reward from "../../models/Reward.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { sendPaymentNotificationEmail } from "../../utils/sendCombinedPaymentEmail.js";
import {
    resolveEmployeeFinePayableAmount,
    resolvePrimaryEmployeeId,
} from "../../utils/finePayableAmount.js";

export const respondToPayment = async (req, res) => {
    try {
        const { id } = req.params;
        const { status, comment } = req.body;

        if (!['Completed', 'Rejected'].includes(status)) {
            return res.status(400).json({ success: false, message: "Invalid status. Must be Completed or Rejected." });
        }

        const payment = await Payment.findById(id);
        if (!payment) {
            return res.status(404).json({ success: false, message: "Payment not found" });
        }

        if (payment.status === 'Completed' || payment.status === 'Rejected') {
            return res.status(400).json({ success: false, message: `Payment already ${payment.status}` });
        }

        payment.status = status;
        payment.remarks = comment || payment.remarks;
        payment.updatedBy = req.user._id;

        // Persist payment status first so subsequent paid-total queries include this payment.
        await payment.save();

        // If approved (Completed), update the related entity (Fine or Loan)
        if (status === 'Completed') {
            const { relatedEntityType, relatedEntityId, referenceId } = payment;

            if (relatedEntityType && (relatedEntityId || referenceId)) {
                if (relatedEntityType === 'Fine') {
                    // Fix: Properly handle fine lookup with null checks
                    let fine = null;
                    if (relatedEntityId) {
                        fine = await Fine.findById(relatedEntityId);
                    }
                    if (!fine && referenceId) {
                        fine = await Fine.findOne({ fineId: referenceId });
                    }
                    
                    if (fine) {
                        // Recalculate total paid - Fix: Add relatedEntityType filter to avoid mixing with other entity types
                        const paymentQuery = {
                            relatedEntityType: 'Fine',
                            status: 'Completed',
                            $or: []
                        };
                        
                        if (fine._id) {
                            paymentQuery.$or.push({ relatedEntityId: fine._id });
                        }
                        if (fine.fineId) {
                            paymentQuery.$or.push({ referenceId: fine.fineId });
                        }
                        
                        // If no $or conditions, skip query
                        if (paymentQuery.$or.length === 0) {
                            console.error('[RespondToPayment] Fine found but no valid ID for payment lookup:', fine._id, fine.fineId);
                        } else {
                            const allPayments = await Payment.find(paymentQuery);
                            const totalPaid = allPayments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
                            fine.paidAmount = totalPaid;

                            const payer = payment.paidBy
                                ? await EmployeeBasic.findById(payment.paidBy).select('employeeId').lean()
                                : null;
                            const empShare = resolveEmployeeFinePayableAmount(
                                fine,
                                payer?.employeeId || resolvePrimaryEmployeeId(fine),
                            );
                            const remainingAmount = empShare - totalPaid;
                            
                            console.log('[RespondToPayment] Fine payment check:', {
                                fineId: fine.fineId,
                                empShare,
                                totalPaid,
                                remainingAmount,
                                currentStatus: fine.fineStatus
                            });
                            
                            // Fix: Update status to 'Paid' if fully paid (with tolerance for floating point)
                            if (remainingAmount <= 0.01) {
                                fine.fineStatus = 'Paid';
                                console.log('[RespondToPayment] Fine status updated to Paid:', fine.fineId);
                            }
                            await fine.save();
                        }
                    } else {
                        console.error('[RespondToPayment] Fine not found:', { relatedEntityId, referenceId });
                    }
                } else if (relatedEntityType === 'Loan' || relatedEntityType === 'Advance') {
                    let loan = await Loan.findById(relatedEntityId) || await Loan.findOne({ loanId: referenceId });
                    if (loan) {
                        // Do not complete Paid to Employee unless Zoho Expense already exists (or sync now succeeds).
                        const hasZoho = Boolean(String(loan.zohoExpenseId || payment.zohoExpenseId || '').trim());
                        if (!hasZoho) {
                            const paidThroughId = String(
                                payment.paidThroughAccountId || loan.paidThroughAccountId || '',
                            ).trim();
                            const expenseId = String(
                                payment.expenseAccountId || loan.expenseAccountId || '',
                            ).trim();
                            const orgId = String(
                                payment.zohoOrganizationId || loan.zohoOrganizationId || '',
                            ).trim();
                            if (!paidThroughId || !expenseId || !orgId) {
                                payment.status = 'Failed';
                                payment.zohoSyncError =
                                    'Zoho Expense required before Paid to Employee. Fill Loan Parties accounts and retry Pay.';
                                await payment.save();
                                return res.status(422).json({
                                    success: false,
                                    message: payment.zohoSyncError,
                                    payment,
                                });
                            }
                            try {
                                const employee = await EmployeeBasic.findById(payment.paidBy).lean();
                                const { syncLoanPaymentToZoho } = await import(
                                    '../../utils/syncRewardPaymentToZoho.js'
                                );
                                const zohoResult = await syncLoanPaymentToZoho({
                                    payment,
                                    loan,
                                    employee,
                                    organizationId: orgId,
                                    expenseAccountId: expenseId,
                                    expenseAccountName:
                                        payment.expenseAccountName || loan.expenseAccountName,
                                    paidThroughAccountId: paidThroughId,
                                    paidThroughAccountName:
                                        payment.paidThroughAccountName || loan.paidThroughAccountName,
                                });
                                if (!zohoResult.ok || !String(zohoResult.expenseId || '').trim()) {
                                    payment.status = 'Failed';
                                    payment.zohoSyncError = zohoResult.message || 'Zoho sync failed';
                                    await payment.save();
                                    loan.zohoSyncError = zohoResult.message || 'Zoho sync failed';
                                    await loan.save();
                                    return res.status(422).json({
                                        success: false,
                                        message:
                                            zohoResult.message ||
                                            'Zoho Expense failed. Loan was not marked Paid.',
                                        payment,
                                        zohoSync: { ok: false, message: zohoResult.message || '' },
                                    });
                                }
                                payment.zohoExpenseId = zohoResult.expenseId;
                                payment.zohoSyncError = '';
                                await payment.save();
                                loan.zohoExpenseId = zohoResult.expenseId;
                                loan.zohoExpenseNumber = zohoResult.expenseNumber || '';
                                loan.zohoOrganizationId = zohoResult.organizationId || orgId;
                                loan.zohoSyncedAt = new Date();
                                loan.zohoSyncError = '';
                            } catch (zohoErr) {
                                payment.status = 'Failed';
                                payment.zohoSyncError = zohoErr?.message || 'Zoho sync failed';
                                await payment.save();
                                return res.status(422).json({
                                    success: false,
                                    message: payment.zohoSyncError,
                                    payment,
                                });
                            }
                        }

                        const allPayments = await Payment.find({
                            $or: [{ relatedEntityId: loan._id }, { referenceId: loan.loanId }],
                            status: 'Completed'
                        });
                        const totalPaid = allPayments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
                        loan.paidAmount = totalPaid;

                        if (parseFloat(loan.amount || 0) - totalPaid <= 0.01) {
                            const { applyLoanFullyPaid } = await import('../../utils/loanPaymentStatus.js');
                            await applyLoanFullyPaid(loan);
                        } else {
                            await loan.save();
                        }
                    }
                } else if (relatedEntityType === 'Reward') {
                    let reward = null;
                    if (relatedEntityId) {
                        reward = await Reward.findById(relatedEntityId);
                    }
                    if (!reward && referenceId) {
                        const cleanRef = String(referenceId).replace(/^rewrd\./i, '');
                        reward = await Reward.findOne({ rewardId: cleanRef });
                    }
                    if (reward) {
                        const { applyRewardPaymentTotals } = await import('../../utils/rewardPaymentStatus.js');
                        await applyRewardPaymentTotals(reward);
                    }
                }
            }
        }

        // Update Dashboard Action

        // Update Dashboard Action
        try {
            await DashboardAction.findOneAndUpdate(
                { requestId: payment._id, requestType: 'Payment Approval' },
                { status: status === 'Completed' ? 'Approved' : 'Rejected', actionedDate: new Date(), actionedBy: req.user._id }
            );
        } catch (dashErr) {
            console.error("[RespondToPayment] Dashboard update fail:", dashErr);
        }

        // Send Combined Status & Invoice Email to Employee
        sendPaymentNotificationEmail(payment, status, comment).catch(e => console.error("[RespondToPayment] Notification fail:", e));

        res.json({ success: true, message: `Payment ${status.toLowerCase()} successfully`, payment });

    } catch (error) {
        console.error("Error in respondToPayment:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};
