function cleanText(value, fallback = '') {
    const text = String(value ?? '').trim();
    return text || fallback;
}

function numberValue(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function resolveLocationName(row) {
    return cleanText(row?.location_name || row?.branch_name || row?.place_of_supply);
}

/** Zoho vendor payment status for ERP list/detail — prefer Paid over Applied. */
export function normalizeVendorPaymentStatus(payment) {
    const raw = cleanText(payment?.status);
    const balance = numberValue(payment?.balance);
    const lower = raw.toLowerCase();

    if (lower.includes('void')) return 'Void';
    if (lower.includes('draft')) return 'Draft';
    if (lower.includes('pending')) return 'Pending Approval';
    if (lower.includes('reject')) return 'Approval Rejected';
    if (lower.includes('partial')) return 'Partially Paid';
    if (lower.includes('paid') || lower.includes('applied') || lower.includes('approved')) {
        return 'Paid';
    }
    if (raw) return raw;
    if (balance > 0) return 'Partially Paid';
    return 'Paid';
}

export function mapZohoExpenseToDoc(expense, organizationId, syncedAt = new Date()) {
    const zohoExpenseId = cleanText(expense?.expense_id || expense?.id);
    if (!zohoExpenseId) return null;

    return {
        zohoExpenseId,
        organizationId,
        date: cleanText(expense.date),
        accountName: cleanText(expense.account_name),
        vendorId: cleanText(expense.vendor_id),
        vendorName: cleanText(expense.vendor_name),
        customerName: cleanText(expense.customer_name),
        referenceNumber: cleanText(expense.reference_number),
        status: cleanText(expense.status),
        locationName: resolveLocationName(expense),
        description: cleanText(expense.description),
        total: numberValue(expense.total ?? expense.bcy_total ?? expense.amount),
        currencyCode: cleanText(expense.currency_code, 'AED') || 'AED',
        isActive: true,
        lastSyncedAt: syncedAt,
        zohoRaw: expense,
    };
}

export function mapZohoBillToDoc(bill, organizationId, syncedAt = new Date()) {
    const zohoBillId = cleanText(bill?.bill_id || bill?.id);
    if (!zohoBillId) return null;

    return {
        zohoBillId,
        organizationId,
        date: cleanText(bill.date),
        billNumber: cleanText(bill.bill_number || bill.reference_number || zohoBillId),
        referenceNumber: cleanText(bill.reference_number),
        vendorId: cleanText(bill.vendor_id),
        vendorName: cleanText(bill.vendor_name),
        status: cleanText(bill.status),
        dueDate: cleanText(bill.due_date),
        locationName: resolveLocationName(bill),
        total: numberValue(bill.total),
        balance: numberValue(bill.balance),
        currencyCode: cleanText(bill.currency_code, 'AED') || 'AED',
        isActive: true,
        lastSyncedAt: syncedAt,
        zohoRaw: bill,
    };
}

function resolveVendorPaymentBillNumbers(payment) {
    const direct = cleanText(payment?.bill_numbers || payment?.bill_number);
    if (direct) return direct;

    const fromBills = Array.isArray(payment?.bills)
        ? payment.bills
              .map((bill) => cleanText(bill?.bill_number || bill?.billNumber || bill?.ref_number))
              .filter(Boolean)
        : [];
    if (fromBills.length) return [...new Set(fromBills)].join(', ');

    const fromApplied = Array.isArray(payment?.applied_bills)
        ? payment.applied_bills
              .map((bill) => cleanText(bill?.bill_number || bill?.billNumber))
              .filter(Boolean)
        : [];
    if (fromApplied.length) return [...new Set(fromApplied)].join(', ');

    return '';
}

export function mapZohoVendorPaymentToDoc(payment, organizationId, syncedAt = new Date()) {
    const zohoPaymentId = cleanText(
        payment?.payment_id || payment?.vendorpayment_id || payment?.id,
    );
    if (!zohoPaymentId) return null;

    return {
        zohoPaymentId,
        organizationId,
        date: cleanText(payment.date),
        paymentNumber: cleanText(payment.payment_number || payment.payment_no || zohoPaymentId),
        referenceNumber: cleanText(payment.reference_number),
        vendorId: cleanText(payment.vendor_id),
        vendorName: cleanText(payment.vendor_name),
        billNumbers: resolveVendorPaymentBillNumbers(payment),
        paymentMode: cleanText(payment.payment_mode),
        paidThroughAccountId: cleanText(
            payment.paid_through_account_id || payment.account_id,
        ),
        paidThroughAccountName: cleanText(
            payment.paid_through_account_name || payment.account_name,
        ),
        status: normalizeVendorPaymentStatus(payment),
        locationName: resolveLocationName(payment),
        amount: numberValue(payment.amount),
        balance: numberValue(payment.balance),
        currencyCode: cleanText(payment.currency_code || payment.currencyCode, 'AED') || 'AED',
        isActive: true,
        lastSyncedAt: syncedAt,
        zohoRaw: payment,
    };
}

/** Lean list/detail shape — never spreads zohoRaw (keeps payloads small). */
export function toZohoExpenseApiShape(doc) {
    if (!doc) return null;

    return {
        expense_id: doc.zohoExpenseId,
        date: doc.date,
        account_name: doc.accountName,
        vendor_id: doc.vendorId,
        vendor_name: doc.vendorName,
        customer_name: doc.customerName,
        reference_number: doc.referenceNumber,
        status: doc.status,
        location_name: doc.locationName || '',
        description: doc.description || '',
        total: doc.total,
        currency_code: doc.currencyCode,
    };
}

export function toZohoBillApiShape(doc) {
    if (!doc) return null;

    return {
        bill_id: doc.zohoBillId,
        date: doc.date,
        bill_number: doc.billNumber,
        reference_number: doc.referenceNumber,
        vendor_id: doc.vendorId,
        vendor_name: doc.vendorName,
        status: doc.status,
        due_date: doc.dueDate,
        location_name: doc.locationName || '',
        total: doc.total,
        balance: doc.balance,
        currency_code: doc.currencyCode,
        utility_bill_payment_id: doc.utilityBillPaymentId || '',
        utility_parent_bill_number: doc.utilityParentBillNumber || '',
        utility_line_index:
            doc.utilityLineIndex == null || doc.utilityLineIndex === ''
                ? null
                : Number(doc.utilityLineIndex),
        utility_debit_account_id: doc.utilityDebitAccountId || '',
        utility_debit_account_name: doc.utilityDebitAccountName || '',
        utility_item_description: doc.utilityItemDescription || '',
    };
}

export function toZohoVendorPaymentApiShape(doc) {
    if (!doc) return null;

    return {
        payment_id: doc.zohoPaymentId,
        date: doc.date,
        payment_number: doc.paymentNumber,
        reference_number: doc.referenceNumber,
        vendor_id: doc.vendorId,
        vendor_name: doc.vendorName,
        bill_numbers: doc.billNumbers,
        payment_mode: doc.paymentMode,
        paid_through_account_id: doc.paidThroughAccountId || '',
        paid_through_account_name: doc.paidThroughAccountName || '',
        status: doc.status || 'Paid',
        location_name: doc.locationName || '',
        amount: doc.amount,
        balance: doc.balance,
        currency_code: doc.currencyCode,
    };
}
