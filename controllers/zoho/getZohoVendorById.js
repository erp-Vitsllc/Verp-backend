import { fetchVendorContact } from '../../services/zohoService.js';
import { mapZohoErrorStatus } from './zohoVendorPaymentUtils.js';

function formatAddress(address) {
    if (!address || typeof address !== 'object') return '';
    return [
        address.attention,
        address.address,
        address.street2,
        [address.city, address.state, address.zip].filter(Boolean).join(', '),
        address.country,
    ]
        .map((part) => String(part || '').trim())
        .filter(Boolean)
        .join('\n');
}

function humanizeCode(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    return raw
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function formatLanguage(contact) {
    const formatted = String(contact.language_code_formatted || '').trim();
    if (formatted) return formatted;
    const code = String(contact.language_code || '').trim().toLowerCase();
    if (!code) return '';
    const map = {
        en: 'English',
        ar: 'Arabic',
        fr: 'French',
        de: 'German',
        es: 'Spanish',
        hi: 'Hindi',
    };
    return map[code] || humanizeCode(code);
}

export const getZohoVendorById = async (req, res) => {
    try {
        const vendorId = String(req.params?.vendorId || '').trim();
        if (!vendorId) {
            return res.status(400).json({ success: false, message: 'Vendor id is required.' });
        }

        const contact = await fetchVendorContact(vendorId);
        if (!contact) {
            return res.status(404).json({ success: false, message: 'Vendor not found in Zoho Books.' });
        }

        const billing = contact.billing_address || contact.address || {};
        const portalEnabled = Boolean(
            contact.is_portal_enabled ?? contact.portal_status === 'enabled',
        );

        const data = {
            contact_id: contact.contact_id,
            contact_name: contact.contact_name,
            company_name: contact.company_name,
            email: contact.email,
            phone: contact.phone || contact.mobile,
            website: contact.website,
            currency_code: contact.currency_code || 'AED',
            outstanding_payable_amount: Number(contact.outstanding_payable_amount) || 0,
            unused_credits_payable_amount: Number(contact.unused_credits_payable_amount) || 0,
            payment_terms: contact.payment_terms,
            payment_terms_label:
                contact.payment_terms_label ||
                humanizeCode(contact.payment_terms) ||
                'Due on Receipt',
            tax_treatment: contact.tax_treatment || '',
            tax_treatment_formatted:
                contact.tax_treatment_formatted ||
                humanizeCode(contact.tax_treatment) ||
                '',
            tax_reg_no: contact.tax_reg_no || contact.vat_reg_no || '',
            place_of_contact: contact.place_of_contact || '',
            place_of_contact_formatted:
                contact.place_of_contact_formatted ||
                humanizeCode(contact.place_of_contact) ||
                '',
            language_code: contact.language_code || '',
            language_code_formatted: formatLanguage(contact),
            is_portal_enabled: portalEnabled,
            portal_status: portalEnabled ? 'Enabled' : 'Disabled',
            billing_address: billing,
            billing_address_text: formatAddress(billing),
            notes: contact.notes,
            status: contact.status,
            raw: contact,
        };

        return res.status(200).json({ success: true, data });
    } catch (error) {
        console.error('[ZohoVendorById] Failed:', error?.message || error);
        const message = error?.message || 'Failed to fetch vendor from Zoho Books';
        return res.status(mapZohoErrorStatus(message)).json({
            success: false,
            message,
        });
    }
};
