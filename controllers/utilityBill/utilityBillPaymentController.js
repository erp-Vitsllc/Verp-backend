import UtilityBillPayment from '../../models/UtilityBillPayment.js';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import { getDepartmentHOD } from '../../utils/getDepartmentHOD.js';
import { syncDashboardAction } from '../../utils/syncDashboard.js';
import { sendUtilityBillPaymentEmail } from '../../utils/sendUtilityBillPaymentEmail.js';

const REQUEST_TYPE = 'Utility Bill Payment';

function computePaySplit(amount, monthlyRental, paymentBy) {
    const amt = Math.max(0, Number(amount) || 0);
    const monthly = Math.max(0, Number(monthlyRental) || 0);
    if (paymentBy === 'employee_balance') {
        const companyPayAmount = Math.min(amt, monthly);
        const employeePayAmount = Math.max(0, amt - monthly);
        return { companyPayAmount, employeePayAmount };
    }
    return { companyPayAmount: amt, employeePayAmount: 0 };
}

async function resolveRequesterEmployee(user) {
    if (!user) return null;
    const oid = user.employeeObjectId || user.employeeId;
    if (oid) {
        const emp = await EmployeeBasic.findById(oid)
            .select('firstName lastName employeeId companyEmail workEmail personalEmail email status')
            .lean();
        if (emp) return emp;
    }
    return null;
}

function requesterDisplayName(emp, user) {
    if (emp) return `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || emp.employeeId || 'User';
    return user?.name || 'User';
}

export async function listUtilityBillPayments(req, res) {
    try {
        const { entryId } = req.query;
        if (!entryId) {
            return res.status(400).json({ message: 'entryId is required' });
        }
        const bills = await UtilityBillPayment.find({ entryId: String(entryId) })
            .sort({ createdAt: -1 })
            .lean();
        return res.status(200).json({ bills });
    } catch (err) {
        return res.status(500).json({ message: err.message || 'Failed to load bills' });
    }
}

export async function createUtilityBillPayment(req, res) {
    try {
        const {
            entryId,
            utilityType,
            amount,
            monthlyRental = 0,
            billMonth = '',
            notes = '',
            sendForHr = false,
        } = req.body || {};

        if (!entryId || !utilityType) {
            return res.status(400).json({ message: 'entryId and utilityType are required' });
        }
        const amt = Number(amount);
        if (!Number.isFinite(amt) || amt < 0) {
            return res.status(400).json({ message: 'Valid amount is required' });
        }

        const monthly = Math.max(0, Number(monthlyRental) || 0);
        const needsHr = Boolean(sendForHr) || amt > monthly;

        const requester = await resolveRequesterEmployee(req.user);
        const requestedByName = requesterDisplayName(requester, req.user);

        if (needsHr) {
            const hr = await getDepartmentHOD('hr');
            if (!hr?._id) {
                return res.status(400).json({
                    message: 'HR responsible person is not configured in Flowchart.',
                });
            }

            // Payment by is set only when HR approves — not at submit time.
            const bill = await UtilityBillPayment.create({
                entryId: String(entryId),
                utilityType: String(utilityType).trim(),
                amount: amt,
                monthlyRental: monthly,
                billMonth: String(billMonth || ''),
                notes: String(notes || ''),
                companyPayAmount: 0,
                employeePayAmount: 0,
                status: 'Pending HR',
                requestedBy: requester?._id || null,
                requestedByName,
            });

            const detailsPath = `/HRM/Asset/UtilityBills/details/${encodeURIComponent(String(entryId))}?billId=${encodeURIComponent(String(bill._id))}`;

            await syncDashboardAction({
                requestId: bill._id,
                requestType: REQUEST_TYPE,
                status: 'Pending',
                assignedTo: hr._id,
                subjectEmployee: requester || null,
                requestedByName,
                extra1: `${utilityType} bill — ${amt.toLocaleString()} AED`,
                extra2: 'Awaiting HR approval',
                extra3: JSON.stringify({
                    entryId: String(entryId),
                    billId: String(bill._id),
                    utilityType,
                    detailsPath,
                }),
            });

            await sendUtilityBillPaymentEmail({ recipient: hr, bill, kind: 'pending' });

            return res.status(201).json({ bill, sentToHr: true });
        }

        const bill = await UtilityBillPayment.create({
            entryId: String(entryId),
            utilityType: String(utilityType).trim(),
            amount: amt,
            monthlyRental: monthly,
            billMonth: String(billMonth || ''),
            notes: String(notes || ''),
            paymentBy: 'company',
            companyPayAmount: amt,
            employeePayAmount: 0,
            status: 'Approved',
            requestedBy: requester?._id || null,
            requestedByName,
            actionedAt: new Date(),
        });

        return res.status(201).json({ bill, sentToHr: false });
    } catch (err) {
        console.error('[createUtilityBillPayment]', err);
        return res.status(500).json({ message: err.message || 'Failed to create bill' });
    }
}

export async function respondUtilityBillPayment(req, res) {
    try {
        const { id } = req.params;
        const { decision, comment = '', paymentBy = null } = req.body || {};
        const action = String(decision || '').toLowerCase();
        if (!['approve', 'reject'].includes(action)) {
            return res.status(400).json({ message: 'decision must be approve or reject' });
        }

        const bill = await UtilityBillPayment.findById(id);
        if (!bill) return res.status(404).json({ message: 'Bill not found' });
        if (bill.status !== 'Pending HR') {
            return res.status(400).json({ message: 'This bill is not awaiting HR approval.' });
        }

        const actor = await resolveRequesterEmployee(req.user);
        const hr = await getDepartmentHOD('hr');
        const role = String(req.user?.role || req.user?.userType || '').toLowerCase();
        const isAdminUser = role.includes('admin') || role.includes('super');
        const isHrUser = Boolean(hr?._id && actor?._id && String(hr._id) === String(actor._id));

        if (!isHrUser && !isAdminUser) {
            return res.status(403).json({ message: 'Only HR can respond to this request.' });
        }

        const requester = bill.requestedBy
            ? await EmployeeBasic.findById(bill.requestedBy)
                  .select('firstName lastName companyEmail workEmail personalEmail email employeeId')
                  .lean()
            : null;

        if (action === 'reject') {
            await syncDashboardAction({
                requestId: bill._id,
                requestType: REQUEST_TYPE,
                status: 'Rejected',
                assignedTo: hr?._id || actor?._id,
                actionedBy: actor?._id || req.user?._id,
                comment: comment || 'Rejected by HR',
                requestedByName: bill.requestedByName,
                extra1: `${bill.utilityType} bill rejected`,
                extra2: comment || 'Rejected — bill deleted',
                subjectEmployee: requester,
            });

            const snapshot = bill.toObject();
            await UtilityBillPayment.findByIdAndDelete(bill._id);

            if (requester) {
                await sendUtilityBillPaymentEmail({
                    recipient: requester,
                    bill: snapshot,
                    kind: 'rejected',
                });
            }

            return res.status(200).json({ deleted: true, billId: id });
        }

        const mode = String(paymentBy || '').trim();
        if (mode !== 'company' && mode !== 'employee_balance') {
            return res.status(400).json({
                message: 'Payment by is required (pay by company or balance pay by employee).',
            });
        }
        const split = computePaySplit(bill.amount, bill.monthlyRental, mode);
        bill.paymentBy = mode;
        bill.companyPayAmount = split.companyPayAmount;
        bill.employeePayAmount = split.employeePayAmount;
        bill.status = 'Approved';
        bill.actionedBy = actor?._id || null;
        bill.actionedAt = new Date();
        bill.comment = comment || '';
        await bill.save();

        await syncDashboardAction({
            requestId: bill._id,
            requestType: REQUEST_TYPE,
            status: 'Approved',
            assignedTo: hr?._id || actor?._id,
            actionedBy: actor?._id || req.user?._id,
            comment: comment || 'Approved by HR',
            requestedByName: bill.requestedByName,
            extra1: `${bill.utilityType} bill approved`,
            extra2: 'Completed',
            subjectEmployee: requester,
            extra3: JSON.stringify({
                entryId: bill.entryId,
                billId: String(bill._id),
                utilityType: bill.utilityType,
                detailsPath: `/HRM/Asset/UtilityBills/details/${encodeURIComponent(bill.entryId)}?billId=${encodeURIComponent(String(bill._id))}`,
            }),
        });

        if (requester) {
            await sendUtilityBillPaymentEmail({
                recipient: requester,
                bill,
                kind: 'approved',
            });
        }

        return res.status(200).json({ bill });
    } catch (err) {
        console.error('[respondUtilityBillPayment]', err);
        return res.status(500).json({ message: err.message || 'Failed to respond' });
    }
}

export async function getUtilityBillPayment(req, res) {
    try {
        const bill = await UtilityBillPayment.findById(req.params.id).lean();
        if (!bill) return res.status(404).json({ message: 'Bill not found' });
        return res.status(200).json({ bill });
    } catch (err) {
        return res.status(500).json({ message: err.message || 'Failed to load bill' });
    }
}
