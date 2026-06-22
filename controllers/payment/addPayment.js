import Payment from "../../models/Payment.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import Fine from "../../models/Fine.js";
import Loan from "../../models/Loan.js";
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
            if (!employee) {
                // Try as ObjectId
                employee = await EmployeeBasic.findById(paidBy);
            }
        } else {
            employee = await EmployeeBasic.findById(paidBy);
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
            attachment: attachment || null
        });

        await payment.save();

        // Update fine/loan status after payment is created (but don't reduce the total amount)
        // Total amount should remain constant - only track payments separately
        if (relatedEntityType && relatedEntityId && status === 'Completed') {
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
            } else if (relatedEntityType === 'Loan') {
                // Find loan by _id or loanId (referenceId)
                let loan = await Loan.findById(relatedEntityId);
                if (!loan && referenceId) {
                    loan = await Loan.findOne({ loanId: referenceId });
                }
                
                if (loan) {
                    // Calculate total paid from all payments (check both by _id and loanId)
                    const paymentQuery = {
                        relatedEntityType: 'Loan',
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
                        loan.status = 'Paid';
                        loan.approvalStatus = 'Paid';
                    }
                    
                    await loan.save();
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

        res.status(201).json({
            success: true,
            message: 'Payment created successfully',
            payment
        });
    } catch (error) {
        console.error('Error creating payment:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to create payment'
        });
    }
};
