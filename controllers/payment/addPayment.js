import Payment from "../../models/Payment.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import Fine from "../../models/Fine.js";
import Loan from "../../models/Loan.js";
import Reward from "../../models/Reward.js";
import UtilityBillPayment from "../../models/UtilityBillPayment.js";
import { getDepartmentHOD, isUserInFlowchart } from "../../utils/getDepartmentHOD.js";
import { syncDashboardAction } from "../../utils/syncDashboard.js";
import { sendPaymentApprovalEmail } from "../../utils/sendPaymentApprovalEmail.js";
import { sendPaymentNotificationEmail } from "../../utils/sendCombinedPaymentEmail.js";
import {
    resolveEmployeeFinePayableAmount,
    resolvePrimaryEmployeeId,
} from "../../utils/finePayableAmount.js";

export const addPayment = async (req, res) => {
    try {
        const {
            paymentType,
            paidBy, // Can be employeeId string or ObjectId
            amount,
            status = 'Pending',
            paymentDate,
            description,
            referenceId,
            relatedEntityType,
            relatedEntityId,
            remarks,
            attachment,
            paymentSource,
            zohoOrganizationId = '',
            paidThroughAccountId = '',
            paidThroughAccountName = '',
            expenseAccountId = '',
            expenseAccountName = '',
        } = req.body;
        
        // CHECK IF CREATOR IS ACCOUNTS PERSON
        const isAccountsUser = await isUserInFlowchart(req.user, 'accounts');
        
        // DEFAULT STATUS logic:
        // If Accounts user creates it, it can be 'Completed' immediately
        // Otherwise it must be 'Processing' (or Pending) and needs approval
        let finalStatus = status;
        if (!isAccountsUser) {
            finalStatus = 'Processing';
        }

        // Validate required fields
        if (!paymentType || !paidBy || !amount) {
            return res.status(400).json({
                success: false,
                message: 'Payment type, paid by, and amount are required'
            });
        }

        const normalizedSource = String(paymentSource || '').trim();
        const allowedSources = ['Salary', 'End of Benefits', 'Cash'];
        if (!normalizedSource || !allowedSources.includes(normalizedSource)) {
            return res.status(400).json({
                success: false,
                message: 'Payment source is required (Salary, End of Benefits, or Cash)',
            });
        }

        const hasAttachment =
            attachment &&
            (attachment.url || attachment.data || attachment.publicId || attachment.name);
        if (normalizedSource === 'Cash' && !hasAttachment) {
            return res.status(400).json({
                success: false,
                message: 'Attachment is required when payment source is Cash',
            });
        }

        // Find employee by employeeId or ObjectId
        let employee;
        if (typeof paidBy === 'string') {
            // Try to find by employeeId first
            employee = await EmployeeBasic.findOne({ employeeId: paidBy });
            if (!employee && /^[0-9a-fA-F]{24}$/.test(paidBy)) {
                // Try as ObjectId
                employee = await EmployeeBasic.findById(paidBy);
            }
        } else if (paidBy && /^[0-9a-fA-F]{24}$/.test(String(paidBy))) {
            employee = await EmployeeBasic.findById(paidBy);
        }

        // Auto-create company placeholder employee profile if it's 'VEGA-HR-0000' or 'VEGA_INTERNAL'
        if (!employee && (paidBy === 'VEGA-HR-0000' || paidBy === 'VEGA_INTERNAL')) {
            employee = new EmployeeBasic({
                employeeId: paidBy,
                firstName: 'Vega Digital IT Solutions',
                lastName: '(Company)',
                email: `${paidBy.toLowerCase()}@internal.vega`,
                dateOfJoining: new Date(),
                status: 'Permanent',
                profileApprovalStatus: 'active',
                profileStatus: 'active'
            });
            await employee.save();
        }

        if (!employee) {
            return res.status(404).json({
                success: false,
                message: 'Employee not found'
            });
        }

        // Generate paymentId before creating payment
        const paymentCount = await Payment.countDocuments();
        const paymentId = `PAY-${String(paymentCount + 1).padStart(6, '0')}`;

        // Create payment
        const payment = new Payment({
            paymentId,
            paymentType,
            paidBy: employee._id,
            paidByName: `${employee.firstName || ''} ${employee.lastName || ''}`.trim(),
            amount: parseFloat(amount),
            status: finalStatus,
            paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
            description: description || '',
            referenceId: referenceId || null,
            relatedEntityType: relatedEntityType || null,
            relatedEntityId: relatedEntityId || null,
            createdBy: req.user._id,
            remarks: remarks || '',
            paymentSource: normalizedSource,
            attachment: attachment || null,
            zohoOrganizationId: String(zohoOrganizationId || '').trim(),
            paidThroughAccountId: String(paidThroughAccountId || '').trim(),
            paidThroughAccountName: String(paidThroughAccountName || '').trim(),
            expenseAccountId: String(expenseAccountId || '').trim(),
            expenseAccountName: String(expenseAccountName || '').trim(),
        });

        await payment.save();

        // Update fine/loan status after payment is created (but don't reduce the total amount)
        // Total amount should remain constant - only track payments separately
        if (relatedEntityType && relatedEntityId && payment.status === 'Completed') {
            if (relatedEntityType === 'Fine') {
                // Find fine by _id or fineId (referenceId)
                let fine = await Fine.findById(relatedEntityId);
                if (!fine && referenceId) {
                    fine = await Fine.findOne({ fineId: referenceId });
                }
                
                if (fine) {
                    // Calculate total paid from all payments (check both by _id and fineId)
                    const paymentQuery = {
                        relatedEntityType: 'Fine',
                        status: 'Completed',
                        $or: []
                    };
                    
                    // Add conditions for finding payments
                    if (fine._id) {
                        paymentQuery.$or.push({ relatedEntityId: fine._id });
                    }
                    if (fine.fineId) {
                        paymentQuery.$or.push({ referenceId: fine.fineId });
                    }
                    
                    // If no $or conditions, skip query
                    if (paymentQuery.$or.length === 0) {
                        console.error('[AddPayment] Fine found but no valid ID for payment lookup:', fine._id, fine.fineId);
                    } else {
                        const allPayments = await Payment.find(paymentQuery);
                        const totalPaid = allPayments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
                        
                        // Update fine's paidAmount field
                        fine.paidAmount = totalPaid;
                        
                        // Calculate employee's share (what they actually owe)
                        const employeeShare = resolveEmployeeFinePayableAmount(
                            fine,
                            employee.employeeId || resolvePrimaryEmployeeId(fine),
                        );
                        
                        // If fully paid (remaining amount is 0 or less), update fine status to 'Paid'
                        const remainingAmount = employeeShare - totalPaid;
                        
                        console.log('[AddPayment] Fine payment check:', {
                            fineId: fine.fineId,
                            employeeShare,
                            totalPaid,
                            remainingAmount,
                            currentStatus: fine.fineStatus
                        });
                        
                        if (remainingAmount <= 0.01) { // Small tolerance for floating point
                            fine.fineStatus = 'Paid';
                            console.log('[AddPayment] Fine status updated to Paid:', fine.fineId);
                        }
                        
                        await fine.save();
                    }
                } else {
                    console.error('[AddPayment] Fine not found:', { relatedEntityId, referenceId });
                }
            } else if (relatedEntityType === 'Loan' || relatedEntityType === 'Advance') {
                // Loan and Salary Advance share the same Loan model + Zoho Expense sync
                let loan = await Loan.findById(relatedEntityId);
                if (!loan && referenceId) {
                    loan = await Loan.findOne({ loanId: referenceId });
                }
                
                if (loan) {
                    // Calculate total paid from all payments (check both by _id and loanId)
                    const paymentQuery = {
                        relatedEntityType: { $in: ['Loan', 'Advance'] },
                        status: 'Completed'
                    };
                    
                    // Try to find payments by relatedEntityId or referenceId
                    const paymentsById = await Payment.find({
                        ...paymentQuery,
                        relatedEntityId: loan._id
                    });
                    
                    const paymentsByRefId = referenceId ? await Payment.find({
                        ...paymentQuery,
                        referenceId: loan.loanId
                    }) : [];
                    
                    // Combine and deduplicate payments
                    const allPaymentIds = new Set();
                    const allPayments = [];
                    [...paymentsById, ...paymentsByRefId].forEach(p => {
                        if (!allPaymentIds.has(p._id.toString())) {
                            allPaymentIds.add(p._id.toString());
                            allPayments.push(p);
                        }
                    });
                    
                    const totalPaid = allPayments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
                    
                    // Update loan's paidAmount field
                    loan.paidAmount = totalPaid;
                    
                    const totalAmount = parseFloat(loan.amount || 0);
                    const remainingAmount = totalAmount - totalPaid;
                    
                    // If fully paid (remaining amount is 0 or less), update loan status to 'Paid'
                    if (remainingAmount <= 0.01) { // Small tolerance for floating point
                        const { applyLoanFullyPaid } = await import('../../utils/loanPaymentStatus.js');
                        await applyLoanFullyPaid(loan);
                    } else {
                        await loan.save();
                    }

                    const paidThroughId = String(
                        paidThroughAccountId ||
                            payment.paidThroughAccountId ||
                            loan.paidThroughAccountId ||
                            '',
                    ).trim();
                    const expenseId = String(
                        expenseAccountId ||
                            payment.expenseAccountId ||
                            loan.expenseAccountId ||
                            '',
                    ).trim();
                    let zohoResult = { ok: false };
                    if (paidThroughId && expenseId) {
                        try {
                            const { syncLoanPaymentToZoho } = await import(
                                '../../utils/syncRewardPaymentToZoho.js'
                            );
                            zohoResult = await syncLoanPaymentToZoho({
                                payment,
                                loan,
                                employee,
                                organizationId: zohoOrganizationId || payment.zohoOrganizationId,
                                expenseAccountId: expenseId,
                                expenseAccountName:
                                    expenseAccountName ||
                                    payment.expenseAccountName ||
                                    loan.expenseAccountName,
                                paidThroughAccountId: paidThroughId,
                                paidThroughAccountName:
                                    paidThroughAccountName ||
                                    payment.paidThroughAccountName ||
                                    loan.paidThroughAccountName,
                            });

                            if (zohoResult.ok) {
                                payment.zohoExpenseId = zohoResult.expenseId || payment.zohoExpenseId || '';
                                payment.zohoJournalId = zohoResult.journalId || payment.zohoJournalId || '';
                                payment.zohoOrganizationId =
                                    zohoResult.organizationId || payment.zohoOrganizationId;
                                payment.zohoSyncError = zohoResult.message && !zohoResult.expenseId
                                    ? zohoResult.message
                                    : '';
                                if (zohoResult.attachment?.ok === false) {
                                    payment.zohoSyncError =
                                        zohoResult.message ||
                                        `Zoho Expense created; attachment failed: ${zohoResult.attachment.message}`;
                                }
                                await payment.save();

                                loan.zohoExpenseId = zohoResult.expenseId || loan.zohoExpenseId;
                                loan.zohoExpenseNumber =
                                    zohoResult.expenseNumber || loan.zohoExpenseNumber || '';
                                loan.zohoJournalId = zohoResult.journalId || loan.zohoJournalId;
                                loan.zohoOrganizationId =
                                    zohoResult.organizationId || loan.zohoOrganizationId;
                                loan.paidThroughAccountId = paidThroughId;
                                loan.paidThroughAccountName =
                                    paidThroughAccountName || payment.paidThroughAccountName;
                                loan.expenseAccountId = expenseId;
                                loan.expenseAccountName =
                                    expenseAccountName || payment.expenseAccountName;
                                loan.zohoSyncedAt = new Date();
                                loan.zohoSyncError =
                                    zohoResult.attachment?.ok === false
                                        ? zohoResult.message || ''
                                        : '';
                                await loan.save();
                            } else {
                                payment.zohoSyncError = zohoResult.message || 'Zoho sync failed';
                                await payment.save();
                                loan.zohoSyncError = zohoResult.message || 'Zoho sync failed';
                                await loan.save();
                                console.warn('[AddPayment] Loan Zoho sync:', zohoResult.message);
                            }
                        } catch (zohoErr) {
                            console.error(
                                '[AddPayment] Loan Zoho sync error:',
                                zohoErr?.message || zohoErr,
                            );
                            payment.zohoSyncError = zohoErr?.message || 'Zoho sync failed';
                            await payment.save();
                            loan.zohoSyncError = zohoErr?.message || 'Zoho sync failed';
                            await loan.save();
                            zohoResult = {
                                ok: false,
                                message: zohoErr?.message || 'Zoho sync failed',
                            };
                        }
                    }

                    // Stash for response message below
                    req._loanZohoSyncResult = zohoResult;

                    try {
                        const { upsertLoanPartyExpenseFromPayment } = await import(
                            '../../utils/upsertLoanPartyExpenseFromPayment.js'
                        );
                        await upsertLoanPartyExpenseFromPayment({
                            loan,
                            payment,
                            employee,
                            zohoResult: zohoResult.ok ? zohoResult : {},
                            userId: req.user?._id || null,
                        });
                    } catch (expenseErr) {
                        console.warn(
                            '[AddPayment] Loan party expense failed:',
                            expenseErr?.message || expenseErr,
                        );
                    }
                }
            } else if (relatedEntityType === 'Reward') {
                let reward = await Reward.findById(relatedEntityId);
                if (!reward && referenceId) {
                    const cleanRef = String(referenceId).replace(/^rewrd\./i, '');
                    reward = await Reward.findOne({ rewardId: cleanRef });
                }

                if (reward) {
                    const { applyRewardPaymentTotals } = await import('../../utils/rewardPaymentStatus.js');
                    await applyRewardPaymentTotals(reward);

                    const paidThroughId = String(
                        paidThroughAccountId ||
                            payment.paidThroughAccountId ||
                            reward.paidThroughAccountId ||
                            '',
                    ).trim();
                    const expenseId = String(
                        expenseAccountId ||
                            payment.expenseAccountId ||
                            reward.expenseAccountId ||
                            '',
                    ).trim();
                    if (paidThroughId && expenseId) {
                        try {
                            const { syncRewardPaymentToZoho } = await import(
                                '../../utils/syncRewardPaymentToZoho.js'
                            );
                            const zohoResult = await syncRewardPaymentToZoho({
                                payment,
                                reward,
                                employee,
                                organizationId:
                                    zohoOrganizationId ||
                                    payment.zohoOrganizationId ||
                                    reward.zohoOrganizationId,
                                expenseAccountId: expenseId,
                                expenseAccountName:
                                    expenseAccountName ||
                                    payment.expenseAccountName ||
                                    reward.expenseAccountName,
                                paidThroughAccountId: paidThroughId,
                                paidThroughAccountName:
                                    paidThroughAccountName ||
                                    payment.paidThroughAccountName ||
                                    reward.paidThroughAccountName,
                            });

                            if (zohoResult.ok) {
                                if (zohoResult.expenseId) {
                                    payment.zohoExpenseId =
                                        zohoResult.expenseId || payment.zohoExpenseId || '';
                                }
                                payment.zohoJournalId =
                                    zohoResult.journalId || payment.zohoJournalId || '';
                                payment.zohoOrganizationId =
                                    zohoResult.organizationId || payment.zohoOrganizationId;
                                payment.zohoSyncError = '';
                                await payment.save();

                                if (zohoResult.expenseId) {
                                    reward.zohoExpenseId =
                                        zohoResult.expenseId || reward.zohoExpenseId || '';
                                }
                                if (zohoResult.journalId) {
                                    reward.zohoJournalId =
                                        zohoResult.journalId || reward.zohoJournalId;
                                }
                                reward.zohoOrganizationId =
                                    zohoResult.organizationId || reward.zohoOrganizationId;
                                reward.paidThroughAccountId = paidThroughId;
                                reward.paidThroughAccountName =
                                    paidThroughAccountName ||
                                    payment.paidThroughAccountName ||
                                    reward.paidThroughAccountName;
                                reward.expenseAccountId = expenseId;
                                reward.expenseAccountName =
                                    expenseAccountName ||
                                    payment.expenseAccountName ||
                                    reward.expenseAccountName;
                                if (!zohoResult.skipped) {
                                    reward.zohoSyncedAt = new Date();
                                }
                                reward.zohoSyncError = '';
                                await reward.save();
                            } else {
                                payment.zohoSyncError = zohoResult.message || 'Zoho sync failed';
                                await payment.save();
                                reward.zohoSyncError = zohoResult.message || 'Zoho sync failed';
                                await reward.save();
                                console.warn('[AddPayment] Reward Zoho sync:', zohoResult.message);
                            }
                        } catch (zohoErr) {
                            console.error(
                                '[AddPayment] Reward Zoho sync error:',
                                zohoErr?.message || zohoErr,
                            );
                            payment.zohoSyncError = zohoErr?.message || 'Zoho sync failed';
                            await payment.save();
                        }
                    }
                }
            } else if (relatedEntityType === 'UtilityBill') {
                let utilityBill = null;
                if (relatedEntityId) {
                    utilityBill = await UtilityBillPayment.findById(relatedEntityId);
                }

                const paidThroughId = String(
                    paidThroughAccountId || payment.paidThroughAccountId || '',
                ).trim();
                const expenseId = String(
                    expenseAccountId || payment.expenseAccountId || '',
                ).trim();

                let zohoResult = { ok: false };
                if (paidThroughId && expenseId) {
                    try {
                        const { syncUtilityEmployeePaymentToZoho } = await import(
                            '../../utils/syncRewardPaymentToZoho.js'
                        );
                        zohoResult = await syncUtilityEmployeePaymentToZoho({
                            payment,
                            employee,
                            utilityBill,
                            organizationId: zohoOrganizationId || payment.zohoOrganizationId,
                            expenseAccountId: expenseId,
                            expenseAccountName: expenseAccountName || payment.expenseAccountName,
                            paidThroughAccountId: paidThroughId,
                            paidThroughAccountName:
                                paidThroughAccountName || payment.paidThroughAccountName,
                        });

                        if (zohoResult.ok) {
                            payment.zohoJournalId = zohoResult.journalId || '';
                            payment.zohoOrganizationId =
                                zohoResult.organizationId || payment.zohoOrganizationId;
                            payment.zohoSyncError = '';
                            await payment.save();
                        } else {
                            payment.zohoSyncError = zohoResult.message || 'Zoho sync failed';
                            await payment.save();
                            console.warn(
                                '[AddPayment] Utility balance Zoho sync:',
                                zohoResult.message,
                            );
                        }
                    } catch (zohoErr) {
                        console.error(
                            '[AddPayment] Utility balance Zoho sync error:',
                            zohoErr?.message || zohoErr,
                        );
                        payment.zohoSyncError = zohoErr?.message || 'Zoho sync failed';
                        await payment.save();
                    }
                }

                try {
                    const { markUtilityBalancePartyExpensePaid } = await import(
                        '../../utils/upsertUtilityBalancePartyExpense.js'
                    );
                    await markUtilityBalancePartyExpensePaid({
                        utilityBillId: String(
                            utilityBill?._id || relatedEntityId || '',
                        ).trim(),
                        employeeId: employee?.employeeId || paidBy,
                        amount: payment.amount,
                        payment,
                        zohoResult: zohoResult.ok ? zohoResult : {},
                        expenseAccountId: expenseId,
                        expenseAccountName: expenseAccountName || payment.expenseAccountName,
                        paidThroughAccountId: paidThroughId,
                        paidThroughAccountName:
                            paidThroughAccountName || payment.paidThroughAccountName,
                        userId: req.user?._id || null,
                    });
                } catch (expenseErr) {
                    console.warn(
                        '[AddPayment] Utility party expense mark-paid failed:',
                        expenseErr?.message || expenseErr,
                    );
                }
            }
        }

        // Send Combined Status & Invoice Email if payment is completed immediately (by Accounts)
        if (payment.status === 'Completed') {
            try {
                // We don't await this to avoid slowing down the response
                sendPaymentNotificationEmail(payment, 'Completed').catch(err => 
                    console.error('[AddPayment] Failed to send notification email:', err)
                );
            } catch (emailErr) {
                console.error('[AddPayment] Error initializing notification email:', emailErr);
            }
        }

        // TRIGGER APPROVAL FLOW FOR ACCOUNTS
        // Only if NOT already completed (i.e. not raised by Accounts)
        if (payment.status !== 'Completed') {
            try {
                const accountsHOD = await getDepartmentHOD('accounts');
                if (accountsHOD) {
                    // 1. Sync to Dashboard
                    await syncDashboardAction({
                        requestId: payment._id,
                        requestType: 'Payment Approval',
                        assignedTo: accountsHOD._id,
                        status: 'Pending',
                        subjectEmployee: employee,
                        requestedByName: req.user.name || '',
                        extra1: payment.paymentType,
                        extra2: `Amount: AED ${payment.amount.toLocaleString()}`
                    });
    
                    // 2. Send Approval Email
                    sendPaymentApprovalEmail(payment, accountsHOD).catch(err => 
                        console.error('[AddPayment] Failed to send payment approval email:', err)
                    );
                }
            } catch (approvalErr) {
                console.error('[AddPayment] Error in approval flow trigger:', approvalErr);
            }
        }

        // Populate for response
        await payment.populate('paidBy', 'employeeId firstName lastName');
        await payment.populate('createdBy', 'firstName lastName');

        const loanZoho = req._loanZohoSyncResult;
        let message = 'Payment created successfully';
        if (loanZoho) {
            if (loanZoho.ok && loanZoho.expenseId) {
                message = loanZoho.message || 'Payment created and Zoho Expense posted.';
            } else if (!loanZoho.ok) {
                message =
                    `Payment saved in ERP, but Zoho Expense failed: ${loanZoho.message || 'sync error'}. ` +
                    'Fix Expense Account (must be an Expense type, not Cash/Bank) on Loan Parties, then Retry Zoho.';
            }
        }

        res.status(201).json({
            success: true,
            message,
            payment,
            zohoSync: loanZoho
                ? {
                      ok: Boolean(loanZoho.ok),
                      expenseId: loanZoho.expenseId || '',
                      expenseNumber: loanZoho.expenseNumber || '',
                      message: loanZoho.message || '',
                  }
                : undefined,
        });
    } catch (error) {
        console.error('Error creating payment:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to create payment'
        });
    }
};
