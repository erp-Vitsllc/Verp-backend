import { createVendor } from '../../services/zohoService.js';
import { mapZohoErrorStatus } from './zohoVendorPaymentUtils.js';

function buildVendorPayload(body = {}) {
    const contactName = String(body.contact_name || body.contactName || body.name || '').trim();
    const companyName = String(body.company_name || body.companyName || '').trim();
    const email = String(body.email || '').trim();
    const phone = String(body.phone || body.workPhone || '').trim();
    const website = String(body.website || '').trim();
    const notes = String(body.notes || '').trim();

    if (!contactName) throw new Error('Vendor name is required.');

    const payload = {
        contact_name: contactName,
        contact_type: 'vendor',
    };

    if (companyName) payload.company_name = companyName;
    if (email) payload.email = email;
    if (phone) payload.phone = phone;
    if (website) payload.website = website;
    if (notes) payload.notes = notes;

    return payload;
}

export const postZohoVendor = async (req, res) => {
    try {
        const payload = buildVendorPayload(req.body || {});
        const data = await createVendor(payload);

        return res.status(201).json({
            success: true,
            data,
            message: 'Vendor has been created in Zoho Books.',
        });
    } catch (error) {
        console.error('[ZohoVendorCreate] Failed:', error?.message || error);
        const message = error?.message || 'Failed to create vendor in Zoho Books';
        const isValidationError = /required/i.test(message);
        return res.status(isValidationError ? 400 : mapZohoErrorStatus(message)).json({
            success: false,
            message,
        });
    }
};
