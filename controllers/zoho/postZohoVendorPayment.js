import { createVendorPayment } from '../../services/zohoService.js';
import { upsertZohoVendorPaymentFromApi } from '../../services/zohoPurchaseSyncService.js';
import { mapZohoErrorStatus, toFiniteAmount } from './zohoVendorPaymentUtils.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cleanBills(bills, paymentAmount) {
    if (!Array.isArray(bills)) return [];

    const clean = bills
        .map((bill) => {
            const billId = String(bill?.bill_id || bill?.billId || '').trim();
            const amountApplied = toFiniteAmount(bill?.amount_applied ?? bill?.amountApplied);

            if (!billId || !Number.isFinite(amountApplied) || amountApplied <= 0) {
                return null;
            }

            return {
                bill_id: billId,
                amount_applied: Number(amountApplied.toFixed(2)),
            };
        })
        .filter(Boolean);

    return clean;
}

function cleanExpenses(expenses, paymentAmount, appliedBillTotal = 0) {
    if (!Array.isArray(expenses)) return [];

    const clean = expenses
        .map((expense) => {
            const expenseId = String(expense?.expense_id || expense?.expenseId || '').trim();
            const amountApplied = toFiniteAmount(expense?.amount_applied ?? expense?.amountApplied);

            if (!expenseId || !Number.isFinite(amountApplied) || amountApplied <= 0) {
                return null;
            }

            return {
                expense_id: expenseId,
                amount_applied: Number(amountApplied.toFixed(2)),
            };
        })
        .filter(Boolean);

    const totalApplied =
        appliedBillTotal + clean.reduce((sum, expense) => sum + expense.amount_applied, 0);
    if (totalApplied - paymentAmount > 0.01) {
        throw new Error('Applied bill and expense amount cannot be greater than the payment amount.');
    }

    return clean;
}

function buildPaymentPayload(body = {}) {
    const vendorId = String(body.vendor_id || body.vendorId || '').trim();
    const date = String(body.date || '').trim();
    const amount = toFiniteAmount(body.amount);
    const paidThroughAccountId = String(
        body.paid_through_account_id || body.paidThroughAccountId || '',
    ).trim();
    const paymentMode = String(body.payment_mode || body.paymentMode || '').trim();
    const referenceNumber = String(body.reference_number || body.referenceNumber || '').trim();
    const description = String(body.description || '').trim();
    const locationId = String(body.location_id || body.locationId || '').trim();

    if (!vendorId) throw new Error('Vendor is required.');
    if (!DATE_RE.test(date)) throw new Error('Payment date must use YYYY-MM-DD format.');
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Payment amount must be greater than zero.');
    if (!paidThroughAccountId) throw new Error('Paid through account is required.');

    const payload = {
        vendor_id: vendorId,
        date,
        amount: Number(amount.toFixed(2)),
        paid_through_account_id: paidThroughAccountId,
    };

    if (paymentMode) payload.payment_mode = paymentMode;
    if (referenceNumber) payload.reference_number = referenceNumber;
    if (description) payload.description = description;
    if (locationId) payload.location_id = locationId;

    const bills = cleanBills(body.bills, payload.amount);
    const billTotal = bills.reduce((sum, bill) => sum + bill.amount_applied, 0);
    if (billTotal - payload.amount > 0.01) {
        throw new Error('Applied bill amount cannot be greater than the payment amount.');
    }
    if (bills.length) payload.bills = bills;

    const expenses = cleanExpenses(body.expenses, payload.amount, billTotal);
    if (expenses.length) payload.expenses = expenses;

    const totalApplied =
        billTotal + expenses.reduce((sum, expense) => sum + expense.amount_applied, 0);
    if (totalApplied - payload.amount > 0.01) {
        throw new Error('Applied bill and expense amount cannot be greater than the payment amount.');
    }

    return payload;
}

export const postZohoVendorPayment = async (req, res) => {
    try {
        const payload = buildPaymentPayload(req.body || {});
        const data = await createVendorPayment(payload);

        try {
            await upsertZohoVendorPaymentFromApi(data);
        } catch (syncError) {
            console.warn(
                '[ZohoVendorPaymentCreate] Zoho create ok; local DB upsert failed:',
                syncError?.message || syncError,
            );
        }

        return res.status(201).json({
            success: true,
            data,
            message: 'Payment made to vendor has been recorded in Zoho Books.',
        });
    } catch (error) {
        console.error('[ZohoVendorPaymentCreate] Failed:', error?.message || error);

        const message = error?.message || 'Failed to create payment made in Zoho Books';
        const isValidationError =
            /required|greater than|YYYY-MM-DD|cannot be greater/i.test(message);

        return res.status(isValidationError ? 400 : mapZohoErrorStatus(message)).json({
            success: false,
            message,
        });
    }
};
