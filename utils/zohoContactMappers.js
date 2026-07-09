export function resolveZohoContactId(contact) {
    return String(contact?.contact_id || contact?.customer_id || contact?.vendor_id || '').trim();
}

export function mapZohoCustomerToDoc(contact, organizationId, syncedAt = new Date()) {
    const zohoContactId = resolveZohoContactId(contact);
    if (!zohoContactId) return null;

    const contactName = String(contact.contact_name || contact.customer_name || '').trim();

    return {
        zohoContactId,
        zohoCustomerId: String(contact.customer_id || contact.contact_id || '').trim(),
        organizationId,
        contactName,
        companyName: String(contact.company_name || '').trim(),
        email: String(contact.email || '').trim(),
        phone: String(contact.phone || '').trim(),
        mobile: String(contact.mobile || '').trim(),
        outstandingReceivableAmount: Number(contact.outstanding_receivable_amount) || 0,
        currencyCode: String(contact.currency_code || 'AED').trim() || 'AED',
        isActive: true,
        lastSyncedAt: syncedAt,
        zohoRaw: contact,
    };
}

export function mapZohoVendorToDoc(contact, organizationId, syncedAt = new Date()) {
    const zohoContactId = resolveZohoContactId(contact);
    if (!zohoContactId) return null;

    const contactName = String(contact.contact_name || contact.vendor_name || '').trim();

    return {
        zohoContactId,
        zohoVendorId: String(contact.vendor_id || contact.contact_id || '').trim(),
        organizationId,
        contactName,
        companyName: String(contact.company_name || '').trim(),
        email: String(contact.email || '').trim(),
        phone: String(contact.phone || '').trim(),
        mobile: String(contact.mobile || '').trim(),
        outstandingPayableAmount: Number(contact.outstanding_payable_amount) || 0,
        currencyCode: String(contact.currency_code || 'AED').trim() || 'AED',
        isActive: true,
        lastSyncedAt: syncedAt,
        zohoRaw: contact,
    };
}

export function toZohoCustomerApiShape(doc) {
    if (!doc) return null;

    return {
        contact_id: doc.zohoContactId,
        customer_id: doc.zohoCustomerId || doc.zohoContactId,
        contact_name: doc.contactName,
        customer_name: doc.contactName,
        company_name: doc.companyName,
        email: doc.email,
        phone: doc.phone,
        mobile: doc.mobile,
        outstanding_receivable_amount: doc.outstandingReceivableAmount,
        currency_code: doc.currencyCode,
    };
}

export function toZohoVendorApiShape(doc) {
    if (!doc) return null;

    return {
        contact_id: doc.zohoContactId,
        vendor_id: doc.zohoVendorId || doc.zohoContactId,
        contact_name: doc.contactName,
        vendor_name: doc.contactName,
        company_name: doc.companyName,
        email: doc.email,
        phone: doc.phone,
        mobile: doc.mobile,
        outstanding_payable_amount: doc.outstandingPayableAmount,
        currency_code: doc.currencyCode,
    };
}
