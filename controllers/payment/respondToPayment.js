import Payment from "../../models/Payment.js";
import DashboardAction from "../../models/DashboardAction.js";
import Fine from "../../models/Fine.js";
import Loan from "../../models/Loan.js";
import { sendPaymentNotificationEmail } from "../../utils/sendCombinedPaymentEmail.js";

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

        // If approved (Completed), update the related entity (Fine or Loan)
        if (status === 'Completed') {
            const { relatedEntityType, relatedEntityId, referenceId } = payment;

            if (relatedEntityType && (relatedEntityId || referenceId)) {
                if (relatedEntityType === 'Fine') {
                    let fine = await Fine.findById(relatedEntityId) || await Fine.findOne({ fineId: referenceId });
                    if (fine) {
                        // Recalculate total paid
                        const allPayments = await Payment.find({
                            $or: [{ relatedEntityId: fine._id }, { referenceId: fine.fineId }],
                            status: 'Completed'
                        });
                        const totalPaid = allPayments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
                        fine.paidAmount = totalPaid;

                        // Check if fully paid
                        const calculateEmployeeShare = (f) => {
                            if (!f) return 0;
                            const isCo = (f.responsibleFor || '').toLowerCase() === 'company';
                            if (isCo) return 0;
                            const realEmps = (f.assignedEmployees || []).filter(e => !['VEGA-HR-0000', 'VEGA_INTERNAL'].includes(e.employeeId));

                            // PRIORITY: Individual Amount
                            if (realEmps.length === 1 && realEmps[0].individualAmount > 0) {
                                return realEmps[0].individualAmount;
                            }

                            const coAmt = parseFloat(f.companyAmount || 0);
                            const fAmt = parseFloat(f.fineAmount || 0);
                            const eAmt = parseFloat(f.employeeAmount || 0);
                            if (realEmps.length === 1 && coAmt === 0) return fAmt;
                            if (eAmt > 0 && eAmt <= fAmt && realEmps.length > 1) return eAmt / realEmps.length;
                            if (realEmps.length === 1 && eAmt > 0 && eAmt <= fAmt) return eAmt;
                            return (fAmt - coAmt) / (realEmps.length || 1);
                        };

                        const empShare = calculateEmployeeShare(fine);
                        if (empShare - totalPaid <= 0.01) {
                            fine.fineStatus = 'Paid';
                        }
                        await fine.save();
                    }
                } else if (relatedEntityType === 'Loan') {
                    let loan = await Loan.findById(relatedEntityId) || await Loan.findOne({ loanId: referenceId });
                    if (loan) {
                        const allPayments = await Payment.find({
                            $or: [{ relatedEntityId: loan._id }, { referenceId: loan.loanId }],
                            status: 'Completed'
                        });
                        const totalPaid = allPayments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
                        loan.paidAmount = totalPaid;

                        if (parseFloat(loan.amount || 0) - totalPaid <= 0.01) {
                            loan.status = 'Paid';
                            loan.approvalStatus = 'Paid';
                        }
                        await loan.save();
                    }
                }
            }
        }

        await payment.save();

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
