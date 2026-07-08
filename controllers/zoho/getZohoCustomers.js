import { fetchCustomers } from '../../services/zohoService.js';

function slimZohoCustomer(contact) {
    if (!contact || typeof contact !== 'object') return null;

    return {
        contact_id: contact.contact_id,
        customer_id: contact.customer_id,
        contact_name: contact.contact_name,
        customer_name: contact.customer_name,
        company_name: contact.company_name,
        email: contact.email,
        phone: contact.phone,
        mobile: contact.mobile,
        outstanding_receivable_amount: contact.outstanding_receivable_amount,
        currency_code: contact.currency_code,
    };
}

export const getZohoCustomers = async (req, res) => {
    try {
        const customers = await fetchCustomers();
        const data = customers.map(slimZohoCustomer).filter(Boolean);

        return res.status(200).json({
            success: true,
            data,
        });
    } catch (error) {
        console.error('[ZohoCustomers] Failed:', error?.message || error);

        const message = error?.message || 'Failed to fetch customers from Zoho Books';
        const status = /not connected|not configured|re-authorize/i.test(message) ? 503 : 502;

        return res.status(status).json({
            success: false,
            message,
        });
    }
};
