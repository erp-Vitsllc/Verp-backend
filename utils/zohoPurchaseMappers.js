function cleanText(value, fallback = '') {
    const text = String(value ?? '').trim();
    return text || fallback;
}

function numberValue(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
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
        total: numberValue(bill.total),
        balance: numberValue(bill.balance),
        currencyCode: cleanText(bill.currency_code, 'AED') || 'AED',
        isActive: true,
        lastSyncedAt: syncedAt,
        zohoRaw: bill,
    };
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
        billNumbers: cleanText(payment.bill_numbers || payment.bill_number),
        paymentMode: cleanText(payment.payment_mode),
        status: cleanText(payment.status),
        amount: numberValue(payment.amount),
        balance: numberValue(payment.balance),
        currencyCode: cleanText(payment.currency_code || payment.currencyCode, 'AED') || 'AED',
        isActive: true,
        lastSyncedAt: syncedAt,
        zohoRaw: payment,
    };
}

/** Prefer full Zoho payload so frontend mappers stay unchanged. */
export function toZohoExpenseApiShape(doc) {
    if (!doc) return null;
    if (doc.zohoRaw && typeof doc.zohoRaw === 'object') {
        return { ...doc.zohoRaw };
    }

    return {
        expense_id: doc.zohoExpenseId,
        date: doc.date,
        account_name: doc.accountName,
        vendor_id: doc.vendorId,
        vendor_name: doc.vendorName,
        customer_name: doc.customerName,
        reference_number: doc.referenceNumber,
        status: doc.status,
        total: doc.total,
        currency_code: doc.currencyCode,
    };
}

export function toZohoBillApiShape(doc) {
    if (!doc) return null;
    if (doc.zohoRaw && typeof doc.zohoRaw === 'object') {
        return { ...doc.zohoRaw };
    }

    return {
        bill_id: doc.zohoBillId,
        date: doc.date,
        bill_number: doc.billNumber,
        reference_number: doc.referenceNumber,
        vendor_id: doc.vendorId,
        vendor_name: doc.vendorName,
        status: doc.status,
        due_date: doc.dueDate,
        total: doc.total,
        balance: doc.balance,
        currency_code: doc.currencyCode,
    };
}

export function toZohoVendorPaymentApiShape(doc) {
    if (!doc) return null;
    if (doc.zohoRaw && typeof doc.zohoRaw === 'object') {
        return { ...doc.zohoRaw };
    }

    return {
        payment_id: doc.zohoPaymentId,
        date: doc.date,
        payment_number: doc.paymentNumber,
        reference_number: doc.referenceNumber,
        vendor_id: doc.vendorId,
        vendor_name: doc.vendorName,
        bill_numbers: doc.billNumbers,
        payment_mode: doc.paymentMode,
        status: doc.status,
        amount: doc.amount,
        balance: doc.balance,
        currency_code: doc.currencyCode,
    };
}
